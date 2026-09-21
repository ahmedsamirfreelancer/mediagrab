# MediaGrab

تطبيق Electron لتنزيل الفيديوهات من TikTok / YouTube / Instagram / Facebook / Pinterest، بواجهة عربية. التشغيل محلياً بـ `npm start` من `E:\ai\01-active\mediagrab`.

## 🟣 النموذج (أهم حاجة — متعكسهاش)

**التطبيق مابيعرضش محتوى أي منصة جوّاه.** التطبيق = خانة واحدة + شاشة تحميلات، وبس.

- **لينك فيديو واحد** → بينزّل على طول.
- **أي حاجة تانية** (كلمة بحث · حساب · صفحة · هاشتاج · الموقع نفسه) → **بيفتح الموقع الحقيقي في شباك لوحده** فيه شريط MediaGrab وزرار «⬇ تحميل» على كل بوست.
- اللي بيتداس عليه جوّه الشباك بيرجع للطابور في الشاشة الرئيسية.

يعني: مفيش شبكة نتايج جوّه البرنامج، مفيش فلاتر، مفيش صفحات، مفيش معاينة. الموقع بيعرض نتايجه بنفسه (نفس اللي المستخدم بيشوفه في متصفحه — بالظبط وكامل)، وإحنا بنحط الأزرار بس. نفس النموذج شغّال على أندرويد كمان (`android-app`).

## Tech stack
- **Electron 32** — تطبيق سطح المكتب (Windows + macOS)
- **Node.js server** — Express + Socket.IO على `http://localhost:3456` (محرّك التحميل والطابور بس)
- **yt-dlp.exe** — مُشغّل التنزيل الأساسي (`resources/yt-dlp.exe`)
- **vanilla JS frontend** — مفيش React/Vue، كله في `server/public/app.js`

## هيكل المشروع
```
E:\ai\01-active\mediagrab\
├── main.js                    # Electron main: النافذة، تسجيل الدخول لكل منصة، سجل المنصات
├── embed/windows.js           # نظام الشبابيك المنبثقة كله (قناة embed:* واحدة)
├── preload-embed-core.js      # شريط التحميل اللي بيتحقن في أي موقع
├── preload-<platform>-embed.js# قواعد المنصة بس: فين البوستات وإيه المفتوح دلوقتي
├── preload-fb-adlibrary.js    # مكتبة إعلانات فيسبوك (أداة التجسّس)
├── preload-main.js            # الجسر: window.electronAPI
├── server/
│   ├── server.js              # محرّك التحميل + الطابور + /api/*
│   └── public/                # index.html · app.js · style.css
├── android-app/               # نفس الواجهة بالظبط + جسر أندرويد (www-shim)
└── resources/                 # yt-dlp + ffmpeg
```

## إزاي الشبابيك شغّالة

1. الواجهة بتنادي `electronAPI.embed.open(platform, { query | url, base })`.
2. `embed/windows.js` بيفتح `BrowserWindow` بجلسة المنصة + الـpreload بتاعها.
3. `preload-embed-core.js` بيحقن الشريط (مجلد الحفظ · حمّل كل الظاهر · تحديد · إيقاف · فتح المجلد) وزرار على كل بوست.
4. أي ضغطة بتبعت `embed:download` بشكل واحد: `{ items:[{url,id,kind}], folder }`.
5. `main.js` بيمرّرها للنافذة الرئيسية → الطابور العادي → yt-dlp.

**إضافة منصة جديدة = صف في `EMBED_PLATFORMS` (في main.js) + ملف قواعد صغير.** مش أكتر. متكتبش قنوات IPC جديدة لكل منصة — دي كانت الحالة القديمة و٥٥٠ سطر مكرر.

## القرارات الحرجة (لا تعكسها)

### مفيش عرض جوّه التطبيق
اتشالت `/api/search` و`/api/info` و`/api/info-stream` وكل شبكة النتايج. لو حد طلب «رجّع النتايج جوّه البرنامج» — ده عكس النموذج كله، اسأل الأول.

### 🪤 Trusted Types = `innerHTML` بيرمي
يوتيوب وفيسبوك وإنستجرام مفعّلين Trusted Types. **أي `innerHTML` جوّه أي preload بيرمي استثناء ويوقّع الشريط كله في صمت** (الستايل بيتحقن والشريط لأ). ابنِ العناصر بـ`createElement` + `textContent`. في النواة فيه `mkEl()` جاهزة.

### 🪤 preload بيـ`require` ملف محلي محتاج `sandbox: false`
الـpreload المعزول (sandbox) بيعرف يـ`require('electron')` بس. كل شبابيك الـembed مضبوطة `sandbox:false` في `embed/windows.js`.

### TikTok user URLs → yt-dlp فقط
- DOM scraping على tiktok.com بيتم رصده من TikTok ويحظر الـIP.
- ⛔ TikWM GET (Cloudflare 403) و`/api/user/posts` (محظور).

### اسم الملف من رقم البوست مش من اللينك
`<platform>_<id>`. اللينك كاسم ملف بيطلّع `https___www...mp4` — ويندوز مش بيفتحه. `nameFor()` في app.js و`title` في الـitems بتعمل ده.

### الكوكيز
- إنستجرام/فيسبوك/تيك توك/بنترست: `userData/data/<platform>-cookies.txt` (Netscape).
- الجلسة الحيّة هي مصدر الحقيقة لو فيها تسجيل دخول؛ الملف بيتحقن **بس** لما الجلسة فاضية (غير كده كل بحث بيدوس على sessionid جديد ويرجّع المستخدم لشاشة الدخول).

### مكتبة إعلانات فيسبوك
تبويب لوحده بلوحة فلاتر، بيفتح `facebook.com/ads/library` بـ**DESKTOP UA** (عشان شكل الشبكة)، والإبداعات بتتحمّل **مباشر** (`downloadFile`) مش عبر yt-dlp.

## التشغيل
```bash
cd E:\ai\01-active\mediagrab
npm start
```
- تعديل في `server/public/*` → Ctrl+R في النافذة.
- تعديل في `main.js` / `server/server.js` / أي preload → اقفل وشغّل تاني.
- أخطاء الواجهة بتطلع في التريمينال في وضع التطوير (`[ui] …`)، وأخطاء الشبابيك بتطلع `[embed] …`.

### تجربة فعلية من غير ما تبص بعينك
شغّل `npx electron . --remote-debugging-port=9222` وبعدين كلّم الصفحة عبر DevTools protocol — كده تقدر تدوس أزرار وتقرا الطابور وتتأكد إن الملف نزل فعلاً.

## Build / Release
- `git push` على `main` بيشغّل `.github/workflows/release.yml`: **ويندوز (nsis) + ماك (dmg arm64 + x64) + أندرويد (APK موقّع)** — كلهم بينشروا في نفس الإصدار على ريبو `mediagrab-releases` العام.
- ⚠️ **`build.files` في package.json قايمة بيضا**: أي ملف جديد في الجذر (أو فولدر زي `embed/`) لازم يتضاف هناك، وإلا النسخة المبنية تطلع ناقصة والتطبيق يقع عند العميل.
- `android-app/build-www.js` بيبني `www/` من `server/public` — **مصدر واحد للواجهة**. لو اتغيّر شكل `index.html` جذرياً راجع الـshim (`www-shim/platformBridge.js`) اللي بيعمل `window.electronAPI` المزيّف على الموبايل.

## ما يجب تجنبه
- ❌ عرض نتايج أي منصة جوّه التطبيق (النموذج كله ضد ده)
- ❌ `innerHTML` في أي preload
- ❌ قناة IPC جديدة لكل منصة — استخدم `embed:*`
- ❌ DOM scraping على TikTok
- ❌ `try/catch` بيبلع الخطأ بلا لوج (ده اللي خلّى الشريط يختفي من غير سبب ظاهر)

---

## 🩺 ضد تضخّم الكود

**الحدود:** ملف ≤500 سطر (فوق 1000 = يتقسم) · دالة ≤80 سطر · تكرار ≤5% · تداخل ≤3.

**قبل ما تكتب:** دوّر على الفكرة في الكود الأول. لو موجودة بـ80% — عدّلها، متكتبش تانية جنبها.

**ممنوع:** طبقة تجريد لحالة واحدة · flag محدش طلبه · wrapper بيمرّر بس ·
`try/catch` بيبلع الخطأ بلا لوج · كود متعلّق (مكومنت) · شيل قبل ما تزود.

**قبل «خلص»:**
```powershell
E:\ai\03-tools\code-audit\01-scan\run-all.ps1 -Only <المشروع> -SkipDup
```
قارن الدرجة والأرقام الخام بآخر تقرير في `E:\ai\03-tools\code-audit\02-reports\`.
**نزلت = شغلك زوّد التضخّم.**

📖 القواعد كاملة: `E:\ai\03-tools\code-audit\03-rules\anti-over-engineering.md`
