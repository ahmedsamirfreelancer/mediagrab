package com.arqami.mediagrab;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.yausername.ffmpeg.FFmpeg;
import com.yausername.youtubedl_android.YoutubeDL;
import com.yausername.youtubedl_android.YoutubeDLException;
import com.yausername.youtubedl_android.YoutubeDLRequest;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

import kotlin.Unit;
import kotlin.jvm.functions.Function3;

/**
 * MediaGrabDownloader — on-device download engine + embedded-browser launcher.
 *
 * Wraps youtubedl-android (yt-dlp + bundled python + ffmpeg). The app's model is
 * a pop-up: openBrowser() launches the real platform page (EmbeddedBrowserActivity);
 * when the user taps a download button there, the page calls back into
 * enqueueFromBrowser(), which runs yt-dlp on the device and streams
 * progress/complete/error events to the web UI's download queue.
 */
@CapacitorPlugin(name = "MediaGrabDownloader")
public class DownloaderPlugin extends Plugin {

    private static volatile boolean initialized = false;
    private static DownloaderPlugin self;
    private static final AtomicLong counter = new AtomicLong(1);
    private final ExecutorService executor = Executors.newCachedThreadPool();

    @Override
    public void load() {
        self = this;
    }

    // ── Engine init ────────────────────────────────────────────────
    @PluginMethod
    public void init(final PluginCall call) {
        executor.execute(() -> {
            try {
                ensureInit();
                JSObject ret = new JSObject();
                ret.put("ready", true);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("init failed: " + e.getMessage(), e);
            }
        });
    }

    private synchronized void ensureInit() throws YoutubeDLException {
        if (initialized) return;
        YoutubeDL.getInstance().init(getContext().getApplicationContext());
        FFmpeg.getInstance().init(getContext().getApplicationContext());
        initialized = true;
    }

    // ── Open the embedded browser (the "pop-up") ───────────────────
    @PluginMethod
    public void openBrowser(final PluginCall call) {
        String url = call.getString("url", "");
        if (url == null || url.trim().isEmpty()) {
            call.reject("no url");
            return;
        }
        Intent i = new Intent(getContext(), EmbeddedBrowserActivity.class);
        i.putExtra("url", url.trim());
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    // ── Direct download (kept for completeness / paste-link path) ──
    @PluginMethod
    public void download(final PluginCall call) {
        final String id = call.getString("id", "dl" + counter.getAndIncrement());
        final String url = call.getString("url", "");
        final boolean audioOnly = Boolean.TRUE.equals(call.getBoolean("audioOnly", false));
        if (url == null || url.trim().isEmpty()) {
            call.reject("no url");
            return;
        }
        executor.execute(() -> {
            try {
                doDownload(id, url.trim(), audioOnly);
                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("id", id);
                call.resolve(ret);
            } catch (Exception e) {
                notifyError(id, e);
                call.reject(e.getMessage() == null ? "download failed" : e.getMessage());
            }
        });
    }

    // ── Called from EmbeddedBrowserActivity when a button is tapped ─
    static void enqueueFromBrowser(final String url, final String title) {
        final DownloaderPlugin p = self;
        if (p == null || url == null || url.trim().isEmpty()) return;
        final String id = "mg" + counter.getAndIncrement();
        p.executor.execute(() -> {
            // create the queue row immediately with a friendly title
            p.notifyProgress(id, 0, title);
            try {
                p.doDownload(id, url.trim(), false);
            } catch (Exception e) {
                p.notifyError(id, e);
            }
        });
    }

    // ── Core download ──────────────────────────────────────────────
    private void doDownload(final String id, String url, boolean audioOnly) throws Exception {
        ensureInit();

        File baseDir = new File(getContext().getExternalFilesDir(null), "downloads/" + safe(id));
        if (!baseDir.exists()) baseDir.mkdirs();

        YoutubeDLRequest request = new YoutubeDLRequest(url);
        request.addOption("--no-playlist");
        request.addOption("--no-mtime");
        request.addOption("--no-part");
        request.addOption("-o", baseDir.getAbsolutePath() + "/%(title).80s.%(ext)s");
        if (audioOnly) {
            request.addOption("-x");
            request.addOption("--audio-format", "mp3");
        } else {
            request.addOption("-f", "bv*+ba/b");
            request.addOption("--merge-output-format", "mp4");
        }

        YoutubeDL.getInstance().execute(request, id, new Function3<Float, Long, String, Unit>() {
            @Override
            public Unit invoke(Float progress, Long etaInSeconds, String line) {
                JSObject ev = new JSObject();
                ev.put("id", id);
                ev.put("progress", progress == null ? 0 : progress.doubleValue());
                ev.put("eta", etaInSeconds == null ? 0 : etaInSeconds.longValue());
                ev.put("line", line);
                notifyListeners("progress", ev);
                return Unit.INSTANCE;
            }
        });

        File produced = largestFileIn(baseDir);
        if (produced == null) throw new Exception("no output file produced");

        Uri saved = publishToDownloads(produced, produced.getName(), mimeFor(produced.getName()));

        JSObject done = new JSObject();
        done.put("id", id);
        done.put("name", produced.getName());
        done.put("filePath", saved != null ? saved.toString() : produced.getAbsolutePath());
        notifyListeners("complete", done);

        try { produced.delete(); baseDir.delete(); } catch (Exception ignore) {}
    }

    private void notifyProgress(String id, double progress, String title) {
        JSObject ev = new JSObject();
        ev.put("id", id);
        ev.put("progress", progress);
        ev.put("title", title);
        notifyListeners("progress", ev);
    }

    private void notifyError(String id, Exception e) {
        JSObject err = new JSObject();
        err.put("id", id);
        err.put("error", e.getMessage() == null ? "download failed" : e.getMessage());
        notifyListeners("error", err);
    }

    // ── helpers ────────────────────────────────────────────────────
    private static String safe(String s) {
        return s == null ? "dl" : s.replaceAll("[^A-Za-z0-9_-]", "_");
    }

    private File largestFileIn(File dir) {
        File[] files = dir.listFiles();
        if (files == null) return null;
        File best = null;
        for (File f : files) {
            if (f.isFile() && (best == null || f.length() > best.length())) best = f;
        }
        return best;
    }

    private String mimeFor(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".mp3")) return "audio/mpeg";
        if (n.endsWith(".m4a")) return "audio/mp4";
        if (n.endsWith(".mp4")) return "video/mp4";
        if (n.endsWith(".webm")) return "video/webm";
        if (n.endsWith(".mkv")) return "video/x-matroska";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }

    private Uri publishToDownloads(File src, String displayName, String mime) throws Exception {
        ContentResolver resolver = getContext().getContentResolver();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, displayName);
            values.put(MediaStore.Downloads.MIME_TYPE, mime);
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/MediaGrab");
            values.put(MediaStore.Downloads.IS_PENDING, 1);
            Uri item = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (item == null) throw new Exception("MediaStore insert failed");
            try (OutputStream os = resolver.openOutputStream(item);
                 InputStream is = new FileInputStream(src)) {
                copy(is, os);
            }
            values.clear();
            values.put(MediaStore.Downloads.IS_PENDING, 0);
            resolver.update(item, values, null, null);
            return item;
        } else {
            File downloads = new File(
                    Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "MediaGrab");
            if (!downloads.exists()) downloads.mkdirs();
            File dest = new File(downloads, displayName);
            try (InputStream is = new FileInputStream(src);
                 OutputStream os = new FileOutputStream(dest)) {
                copy(is, os);
            }
            return Uri.fromFile(dest);
        }
    }

    private static void copy(InputStream is, OutputStream os) throws Exception {
        byte[] buf = new byte[1 << 16];
        int r;
        while ((r = is.read(buf)) != -1) os.write(buf, 0, r);
        os.flush();
    }
}
