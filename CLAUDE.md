# MediaGrab

تطبيق Electron لتنزيل الفيديوهات من TikTok / YouTube / Instagram / Facebook، بواجهة عربية. التشغيل محلياً بـ `npm start` من `E:\ai\downloader-electron`.

## Tech stack
- **Electron 31+** — تطبيق سطح المكتب (Windows)
- **Node.js server** — Express + Socket.IO على `http://localhost:3456`
- **yt-dlp.exe** — مُشغّل التنزيل الأساسي (موجود في `resources/yt-dlp.exe`)
- **TikWM API** — مصدر مساعد لتنزيل فيديوهات TikTok الفردية (POST + form-encoded فقط، الـ GET محظور بـ Cloudflare)
- **vanilla JS frontend** — مفيش React/Vue، كل شيء في `server/public/app.js` (~3k سطر)

## هيكل المشروع
```
E:\ai\downloader-electron\
├── main.js                # Electron main process (BrowserWindow, IPC, server fork)
├── preload-main.js        # contextBridge: instagram/facebook/cookies/license/ytdlp/shell
├── package.json
├── resources/
│   ├── yt-dlp.exe         # الأداة الأساسية
│   └── bin/ffmpeg.exe     # لتحويل MP3
├── server/
│   ├── server.js          # Express + Socket.IO + كل الـ routes (~2300 سطر)
│   └── public/
│       ├── index.html
│       ├── style.css
│       └── app.js         # كل الـ frontend logic
├── license/               # نظام التفعيل/الترخيص
└── scripts/               # build helpers
```

## Architecture
1. Electron `main.js` يفتح Activation window أولاً (license check)
2. بعد التفعيل، يـ `fork()` السيرفر في child process على port 3456
3. الـ main window يـ `loadURL('http://127.0.0.1:3456')` ويعرض الـ UI
4. الـ frontend (`app.js`) يتواصل مع السيرفر بـ:
   - HTTP REST (`/api/info`, `/api/info-stream`, `/api/search`, `/api/download`)
   - Socket.IO للـ progress events والـ listing streaming
   - IPC مع main process عبر `window.electronAPI` (Instagram login، cookies import، إلخ)

## القرارات الحرجة (لا تعكسها)

### TikTok user URLs → yt-dlp فقط
- `tiktok.com/@user` بيتعامل عبر `yt-dlp --flat-playlist --dump-json` (سطر ~1050 في server.js)
- TikWM `/api/user/posts` ممنوع بـ Cloudflare و duplicates لـ carousel posts
- DOM scraping على tiktok.com بيتم رصده من TikTok ويحظر الـ IP
- yt-dlp بيستخدم TikTok's official pagination API ويجيب الـ profile كامل (مختبر: 2019 فيديو، صفر حظر)

### TikWM POST فقط
- `tikwmGetVideo` لتنزيل الفيديو الفردي يستخدم POST + form data
- GET على `tikwm.com/api/?url=...` بيرجع Cloudflare 403

### Media proxy
- `/api/proxy/media?u=<url>` في server.js يـ proxy الـ images والفيديوهات
- TikTok/Instagram/Facebook CDN يرفضون الـ requests من `localhost:3456` (مطلوب Referer = the originating domain)
- الـ frontend يـ wrap كل URL CDN عبر `proxyMedia(url)` في `app.js`

### Pagination في الـ UI
- `state.pagination = { page, size }`، الـ default 50 لكل صفحة
- المخزن في `localStorage` (`mediagrab_page_size`)
- النتائج كلها في `state.results`، الـ UI يعرض صفحة واحدة فقط من `state.filteredResults`

### بحث الكلمات
- **عدد متغير بطبيعته**: كل request لـ TikTok/Instagram/FB/YT بـ keyword بيرجع batch مختلف. ده طبيعي مش bug
- TikTok keyword: TikWM `/api/feed/search` (POST، بيرجع `video_id` مش `id`)
- Instagram keyword: hidden Electron BrowserWindow يـ scrape `instagram.com/explore/search/keyword/?q=`
- YouTube: `ytsearchN:keyword` لـ yt-dlp

### المسارات الخارجية
- Instagram cookies: `userData/data/instagram-cookies.txt` (Netscape format، مُصدّر من Electron session)
- Facebook cookies: `userData/data/facebook-cookies.txt` (نفس الفكرة)
- لا login لـ TikTok (yt-dlp يجيب الكل بدون cookies)

## التشغيل
```bash
cd E:\ai\downloader-electron
npm start
```

**ملاحظة**: لو تعديل في `server/server.js` أو `main.js` لازم تقفل MediaGrab وتعيد تشغيله. لو تعديل في `server/public/*` يكفي Ctrl+R في الـ window.

## Build / Release
- `npm run build` يبني installer بـ electron-builder (راجع `package.json`)
- الـ installer في `dist-pkg/`
- المستخدم يفضّل التشغيل من المصدر (`npm start`) للتطوير، البناء بس عند release

## ملفات مهمة للقراءة قبل التعديل
- **TikTok user URL flow**: `server/server.js:1138-1170` (info) + `:1570-1650` (info-stream)
- **TikWM video download**: `server/server.js:670-720` (tikwmGetVideo)
- **Keyword search per platform**: `server/server.js:1769+`
- **yt-dlp wrapper**: `server/server.js:920-1010` (_ytdlpInfoRaw, _ytdlpInfoCached)
- **Frontend pagination**: `server/public/app.js` — `renderResults`, `renderPagination`, `pageBounds`
- **Media proxy**: `server/server.js:380-440`

## ما يجب تجنبه
- ❌ DOM scraping على TikTok (TikTok يرصد ويحظر)
- ❌ TikWM GET requests (Cloudflare 403)
- ❌ TikWM `/api/user/posts` (Cloudflare محظور)
- ❌ إضافة Electron BrowserWindow لـ scraping tiktok.com (تم تجربته وفشل)
- ❌ تحديث `CLAUDE.md` لكل تغيير — فقط للتغييرات الهيكلية
