#!/usr/bin/env node
/**
 * build-buyer-copy.js — يبني نسخة المشتري من سورس MediaGrab.
 *
 * المشتري بياخد السورس كامل بس من غير أي حاجة بتخصنا: مفيش ورك فلو بيدوس على
 * ريبو إصداراتنا، مفيش تقارير أعطال بتيجي على سيرفرنا، ومفيش معرّف تطبيق باسمنا.
 *
 *   node scripts/build-buyer-copy.js --out ../mediagrab-buyer [--owner <github-user>] [--appid <id>]
 *
 * 🔒 الأداة بتقع (exit 1) في تلات حالات — عمداً:
 *   1. تحويلة متوقّعة ماطبّقتش على أي ملف (يعني السورس اتغيّر والنسخة بقت بتسرّب).
 *   2. فضل في المخرج أي أثر لينا (حسابنا/دوميناتنا/IPs/com.arqami).
 *   3. ملف JS اتكسر بعد التحويل (node --check).
 * الوقوع أحسن من نسخة بتوصل للمشتري وفيها حاجاتنا.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

/* ─── الإعدادات ──────────────────────────────────────────────────────────── */

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf('--' + name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};

const OUT = path.resolve(flag('out', path.join(ROOT, '..', 'mediagrab-buyer')));
const OWNER = flag('owner', 'goharmohamed66');
const APPID = flag('appid', 'com.mediagrab.app');

/* ─── اللي مابيروحش للمشتري ──────────────────────────────────────────────── */

// 🪤 درس نسخة أرقامي: ليستة بالأسامي الكاملة بتفضل ورا الواقع — أي ملف جديد
// بنفس النوع بيعدّي. عشان كده الاستبعاد **بنمط**.
const EXCLUDE_RE = [
  /^CLAUDE\.md$/,                 // تعليمات شغلنا الداخلية + مسارات جهازنا
  /^scripts\/build-buyer-copy\.js$/, // الأداة دي نفسها (جوّاها أسامينا بحكم شغلها)
  /^\.github\/workflows\//,       // ورك فلوهاتنا — نسخة مثال بتتولّد تحت
  /^_handoff/i,                   // مذكرات تسليم داخلية
  /(^|\/)\.env($|\.)/,            // أي env
  /(^|\/)keystore\.properties$/,  // مفاتيح توقيع
];

/* ─── التحويلات (كل واحدة لازم تطبّق على الأقل مرة) ──────────────────────── */

const TRANSFORMS = [
  {
    id: 'releases-repo',
    why: 'روابط التحديث كانت بتأشّر على ريبو إصداراتنا',
    find: /ahmedsamirfreelancer\/mediagrab-releases/g,
    to: OWNER + '/mediagrab-releases',
  },
  {
    id: 'pages-url',
    why: 'صفحة التحميل بتاعتنا',
    find: /ahmedsamirfreelancer\.github\.io/g,
    to: OWNER + '.github.io',
  },
  {
    id: 'publish-owner',
    why: 'هدف النشر في package.json',
    find: /"owner":\s*"ahmedsamirfreelancer"/g,
    to: '"owner": "' + OWNER + '"',
  },
  {
    id: 'error-endpoint',
    why: 'تقارير الأعطال كانت بتتبعت على سيرفرنا',
    find: /process\.env\.MEDIAGRAB_ERROR_ENDPOINT \|\| 'https:\/\/license\.ahmedsamir\.net\/api\/mediagrab\/error'/g,
    to: "process.env.MEDIAGRAB_ERROR_ENDPOINT || ''",
  },
  {
    id: 'error-endpoint-guard',
    why: 'من غير الحارس ده reportError هيحاول يعمل URL من نص فاضي كل مرة',
    find: /function reportError\(err, context = \{\}\) \{\r?\n  try \{\r?\n/g,
    to: 'function reportError(err, context = {}) {\n  if (!ERROR_ENDPOINT) return; // مفيش سيرفر تقارير في النسخة دي\n  try {\n',
  },
  {
    id: 'appid',
    why: 'معرّف التطبيق كان باسم شركتنا',
    find: /com\.arqami\.mediagrab/g,
    to: APPID,
  },
];

/* ─── حارس المخرج: أي أثر لينا = وقوف ────────────────────────────────────── */

const FORBIDDEN = [
  { re: /ahmedsamirfreelancer/i, what: 'حساب جيتهاب بتاعنا' },
  { re: /ahmedsamir\.net/i, what: 'دومين سيرفرنا' },
  { re: /com\.arqami/i, what: 'معرّف تطبيق باسمنا' },
  { re: /\b(?:31\.97\.196\.31|93\.127\.203\.38|72\.61\.162\.82)\b/, what: 'IP سيرفر بتاعنا' },
  { re: /E:\\ai\\/i, what: 'مسار على جهازنا' },
];

const TEXT_EXT = new Set([
  '.js', '.json', '.md', '.yml', '.yaml', '.html', '.css', '.xml', '.java',
  '.gradle', '.properties', '.pro', '.txt', '.bat', '.sh', '.svg',
]);

const isText = (rel) => TEXT_EXT.has(path.extname(rel).toLowerCase()) || path.basename(rel).startsWith('.git');

/* ─── التنفيذ ────────────────────────────────────────────────────────────── */

const die = (msg) => { console.error('\n🚨 وقف البناء: ' + msg + '\n'); process.exit(1); };

const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
  .toString('utf8').split('\0').filter(Boolean)
  .filter((f) => !EXCLUDE_RE.some((re) => re.test(f)));

if (files.length < 50) die('git ls-files رجّع ' + files.length + ' ملف بس — مش منطقي، يبقى فيه حاجة غلط في المسار');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const hits = Object.fromEntries(TRANSFORMS.map((t) => [t.id, 0]));
const JAVA_SRC = 'android/app/src/main/java/com/arqami/mediagrab';
const JAVA_DST = 'android/app/src/main/java/' + APPID.replace(/\./g, '/');

for (const rel of files) {
  // مجلد الباكدج بتاع جافا بيتنقل مع معرّف التطبيق الجديد
  const outRel = rel.replace(JAVA_SRC, JAVA_DST);
  const dst = path.join(OUT, outRel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });

  if (!isText(rel)) { fs.copyFileSync(path.join(ROOT, rel), dst); continue; }

  let body = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const t of TRANSFORMS) {
    const n = (body.match(t.find) || []).length;
    if (n) { hits[t.id] += n; body = body.replace(t.find, t.to); }
  }
  fs.writeFileSync(dst, body);
}

// 1️⃣ تحويلة ماطبّقتش = السورس اتغيّر تحتينا
const dead = TRANSFORMS.filter((t) => hits[t.id] === 0);
if (dead.length) {
  die('تحويلات ماطبّقتش على أي ملف — يعني السورس اتغيّر والنسخة بقت بتسرّب:\n' +
    dead.map((t) => '   • ' + t.id + ' — ' + t.why).join('\n') +
    '\n\nصلّح النمط في scripts/build-buyer-copy.js في نفس الدفعة.');
}

/* ─── ملفات بتتولّد للمشتري ──────────────────────────────────────────────── */

const pkg = JSON.parse(fs.readFileSync(path.join(OUT, 'package.json'), 'utf8'));

// ورك فلو النشر بيتسلّم كـ**مثال** مش تحت .github/workflows —
// عشان مايشتغلش لوحده في ريبو مالوش أسراره.
const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8')
  .replace(/ahmedsamirfreelancer/g, OWNER);
fs.mkdirSync(path.join(OUT, '.github/workflows-example'), { recursive: true });
fs.writeFileSync(path.join(OUT, '.github/workflows-example/release.yml'), wf);

const README = [
  '# MediaGrab — نسخة السورس',
  '',
  'برنامج تحميل فيديوهات من TikTok / YouTube / Instagram / Facebook / Pinterest،',
  'بواجهة عربية، مبني على Electron.',
  '',
  '**الإصدار الحالي:** ' + pkg.version,
  '',
  '## تشغيل من السورس',
  '',
  '```bash',
  'npm install          # بينزّل كمان yt-dlp و ffmpeg تلقائياً',
  'npm start',
  '```',
  '',
  '## بناء نسخة تثبيت',
  '',
  '```bash',
  'npm run build        # ويندوز (NSIS installer) → dist-pkg/',
  'npm run build:mac    # ماك (dmg) — محتاج جهاز ماك',
  '```',
  '',
  'الأندرويد في `android-app/` (Capacitor) — شغّل `node build-www.js` الأول عشان',
  'الواجهة تتولّد من `server/public`.',
  '',
  '## قبل ما تنشر إصدارات بنفسك',
  '',
  'النسخة دي **مش مربوطة بأي سيرفر**: مفيش ترخيص ولا تفعيل ولا تقارير أعطال.',
  'لو عايز التحديث التلقائي يشتغل لمستخدمينك:',
  '',
  '1. اعمل ريبو **عام** اسمه `mediagrab-releases` على حسابك — الإصدارات بتتنشر فيه',
  '   والنسخ المثبّتة بتقرا منه `latest.yml`.',
  '2. `.github/workflows-example/release.yml` هو خط البناء والنشر جاهز — انقله لـ',
  '   `.github/workflows/` وحط الأسرار دي في إعدادات الريبو:',
  '   - `RELEASES_TOKEN` — توكن بصلاحية Contents:write على ريبو الإصدارات',
  '   - `ANDROID_KEYSTORE_BASE64` + `ANDROID_KEYSTORE_PASSWORD` — لو هتبني APK',
  '3. معرّف التطبيق دلوقتي `' + APPID + '` — غيّره لاسمك لو هتنشر على جوجل بلاي.',
  '',
  '## توثيق',
  '',
  '- `docs/macos-install.md` — تثبيت الماك وحكاية الـquarantine',
  '',
  '---',
  'النسخة دي بتتحدّث تلقائياً من مصدر MediaGrab. **متعدّلش عليها هنا** — أي تعديل',
  'هيتدهس مع أول تحديث.',
  '',
].join('\n');

fs.writeFileSync(path.join(OUT, 'README.md'), README);

/* ─── الحراس النهائيين ───────────────────────────────────────────────────── */

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? (e.name === '.git' ? [] : walk(p)) : [p];
});

const out = walk(OUT);
const leaks = [];
for (const p of out) {
  const rel = path.relative(OUT, p).replace(/\\/g, '/');
  if (!isText(rel)) continue;
  const body = fs.readFileSync(p, 'utf8');
  for (const f of FORBIDDEN) {
    const m = body.match(f.re);
    if (m) leaks.push('   • ' + rel + ' — ' + f.what + ' (' + m[0] + ')');
  }
}
// 2️⃣ أثر لينا فضل في المخرج
if (leaks.length) die('فضل في نسخة المشتري حاجات بتخصنا:\n' + leaks.join('\n'));

// 3️⃣ ملف JS اتكسر بعد التحويل
for (const p of out.filter((f) => f.endsWith('.js'))) {
  try {
    execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' });
  } catch (e) {
    die(path.relative(OUT, p) + ' مش بيعدّي node --check بعد التحويل:\n' + e.stderr);
  }
}
JSON.parse(fs.readFileSync(path.join(OUT, 'package.json'), 'utf8'));

console.log('✅ نسخة المشتري جاهزة: ' + OUT);
console.log('   ' + out.length + ' ملف · إصدار ' + pkg.version + ' · appId ' + APPID);
console.log('   التحويلات: ' + TRANSFORMS.map((t) => t.id + '×' + hits[t.id]).join(' · '));
