# MediaGrab على macOS

## تنزيل
صفحة التحميل الموحّدة: https://ahmedsamirfreelancer.github.io/mediagrab-releases/

- **Apple Silicon** (M1/M2/M3/M4): `MediaGrab-<version>-arm64.dmg`
- **Intel**: `MediaGrab-<version>-x64.dmg`

يتطلب macOS 11 (Big Sur) أو أحدث. لو نزّلت نسخة Intel على جهاز Apple Silicon
هيطلب Rosetta أو مايفتحش — اتأكد من النوع من قائمة  ← About This Mac.

## التثبيت — الخطوات التلاتة

1. افتح ملف `.dmg` واسحب **MediaGrab** إلى مجلد **Applications**.
2. افتح **Terminal** ونفّذ السطر ده مرة واحدة:

   ```bash
   xattr -dr com.apple.quarantine /Applications/MediaGrab.app
   ```

3. افتح التطبيق عادي.

**الخطوة 2 مش اختيارية.** النسخة موقّعة توقيع ad-hoc بس (مش بشهادة Apple
Developer)، وأي ملف بينزل من متصفح بياخد علامة الحجر الصحي
(`com.apple.quarantine`). التوقيع الـad-hoc + علامة الحجر = ماك بيقول
**"MediaGrab is damaged and can't be opened"** ويرمي التطبيق في المهملات.
السطر ده بيشيل العلامة وبس — مش بيغيّر حاجة في التطبيق.

> على macOS 15 (Sequoia) وأحدث: حيلة "كليك يمين ← Open" **ماعادتش تشتغل**
> للتطبيقات غير الموقّعة. الطريقة الوحيدة هي أمر `xattr` فوق، أو
> System Settings ← Privacy & Security ← Open Anyway بعد أول محاولة فتح.

## التفعيل
**مفيش تفعيل ومفيش سريال.** البرنامج مفتوح للكل — بيفتح ويشتغل على طول.

## التحديثات
على الماك **مفيش تحديث تلقائي**: Squirrel.Mac بيرفض تحديث أي تطبيق غير موقّع.
بدلها التطبيق بيفحص الإصدارات كل 6 ساعات، ولو في نسخة أحدث بيعرض بانر بزرار
بيفتح صفحة التحميل، وتتثبّت بسحب النسخة الجديدة فوق القديمة (وتعيد أمر `xattr`).

## اللي اتظبط في 1.0.37 (فخاخ ماك — متعيدش اكتشافها)
1. **مفيش قايمة = مفيش Cmd+V ولا Cmd+Q.** الكود كان بيقول
   `Menu.setApplicationMenu(null)` لكل المنصّات. على الماك القايمة هي مصدر كل
   الاختصارات القياسية — من غيرها المستخدم **مش قادر يلصق لينك** ولا يقفل
   البرنامج. بقى في قايمة roles على الماك بس.
2. **قفل النافذة = تطبيق زومبي.** `window-all-closed` كان بيقتل السيرفر ومايقفلش
   التطبيق على الماك، ومفيش `activate` handler — يعني الأيقونة في الـDock
   مابتفتحش نافذة تاني. بقى السيرفر يفضل شغّال + `activate` بيرجّع النافذة.
3. **كل تحميل من نوافذ البوب-اب كان بيفشل.** الواجهة كانت بتقع على مسار ويندوز
   ثابت (`E:\منتجات التست`) لما مايكونش في مجلد محفوظ في الإعدادات. على ماك ده
   **مش مسار مطلق أصلاً**، فالسيرفر كان بيرفضه بـ 400 وماينزلش أي حاجة. بقى في
   `GET /api/env` بيرجّع المنصّة والفاصل والمجلد الافتراضي الحقيقي.
4. **الملفات المدمجة (yt-dlp/ffmpeg/ffprobe) لازم تتوقّع كل واحدة لوحدها.**
   `codesign --deep` بيمشي جوّه الـbundles المتداخلة، والملفات دي قاعدة في
   `Contents/Resources/bin` كـMach-O عادي. على Apple Silicon أي تنفيذي بلا توقيع
   = `Killed: 9`. `afterPack` بقى يوقّع كل واحد **قبل** الـbundle، وبعدين
   `codesign --verify` عشان الخطأ يبان في البناء مش عند العميل.
5. **yt-dlp اللي التطبيق بينزّله بنفسه** بقى يتوقّع ad-hoc ويتشال منه الحجر الصحي
   بعد التنزيل — `chmod +x` لوحده مش كفاية على Apple Silicon.
6. **Login item** على الماك بيتسجّل من غير `path`؛ `process.execPath` هو
   التنفيذي **جوّه** الـbundle والتسجيل بيه بيشغّل عملية عارية مش التطبيق.
7. «إظهار في المجلد» بقى `open -R` (بيحدّد الملف نفسه في Finder) بدل ما يفتح
   المجلد وخلاص.

## لو اتشترى حساب Apple Developer (99$/سنة)
ده اللي بيلغي أمر `xattr` نهائيًا وبيرجّع التحديث التلقائي:
1. ضيف الأسرار `CSC_LINK` (شهادة Developer ID .p12 بترميز base64) و
   `CSC_KEY_PASSWORD` لريبو `mediagrab`، و`APPLE_ID` +
   `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` للتوثيق (notarization).
2. في `.github/workflows/release.yml` (job `build-mac`) اشِل
   `CSC_IDENTITY_AUTO_DISCOVERY: 'false'`.
3. في `package.json` اشِل `"identity": null` وحوّل `hardenedRuntime` لـ `true`،
   وضيف `"notarize": true`، وضيف هدف `zip` جنب `dmg` (electron-updater بيحدّث من الـzip).
4. في `main.js` اشِل فرع `IS_MAC` من `setupAutoUpdater` عشان electron-updater
   يشتغل على الماك زي ويندوز.
5. في `scripts/afterPack-adhoc-sign.js` سيبه زي ما هو أو اشِله — التوقيع الحقيقي
   بيحصل بعده وبيستبدله.
