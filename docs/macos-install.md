# MediaGrab على macOS

## تنزيل
من صفحة الإصدارات: https://github.com/ahmedsamirfreelancer/mediagrab-releases/releases/latest

- **Apple Silicon** (M1/M2/M3/M4): `MediaGrab-<version>-arm64.dmg`
- **Intel**: `MediaGrab-<version>-x64.dmg`

يتطلب macOS 11 (Big Sur) أو أحدث.

## التثبيت

1. افتح ملف `.dmg` واسحب **MediaGrab** إلى مجلد **Applications**.
2. **أول تشغيل فقط:** كليك يمين على أيقونة MediaGrab ← **Open** ← **Open** مرة تانية في التحذير.

الخطوة 2 لازمة لأن النسخة **مش موقّعة** بشهادة Apple Developer، وGatekeeper بيمنع أي تطبيق غير موقّع من الفتح بالدبل-كليك العادي. الكليك اليمين مرة واحدة بيسجّل استثناء دائم للتطبيق.

لو ظهرت رسالة **"MediaGrab is damaged and can't be opened"** (بيحصل لما الملف ينزل من متصفح بيضيف علامة الحجر الصحي)، افتح Terminal ونفّذ:

```bash
xattr -dr com.apple.quarantine /Applications/MediaGrab.app
```

## التفعيل
نفس نظام ويندوز: أول تشغيل يطلب السريال، والترخيص مدى الحياة ومربوط ببصمة الجهاز (`IOPlatformUUID` على الماك). تغيير الجهاز بيعيد الربط تلقائيًا.

## التحديثات
على الماك **مفيش تحديث تلقائي**: Squirrel.Mac بيرفض تحديث أي تطبيق غير موقّع. بدلها التطبيق بيفحص الإصدارات كل 6 ساعات، ولو في نسخة أحدث بيعرض بانر بزرار بيفتح صفحة التحميل، وتتثبّت بسحب النسخة الجديدة فوق القديمة.

**لو اتشترى حساب Apple Developer (99$/سنة)** يتحل الاتنين (Gatekeeper + التحديث التلقائي):
1. ضيف الأسرار `CSC_LINK` (شهادة Developer ID .p12 بترميز base64) و`CSC_KEY_PASSWORD` لريبو `mediagrab`، و`APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` للتوثيق (notarization).
2. في `.github/workflows/release.yml` (job `build-mac`) اشِل `CSC_IDENTITY_AUTO_DISCOVERY: 'false'`.
3. في `package.json` اشِل `"identity": null` وحوّل `hardenedRuntime` لـ `true`، وضيف `"notarize": true`، وضيف هدف `zip` جنب `dmg` (electron-updater بيحدّث من الـzip).
4. في `main.js` اشِل فرع `IS_MAC` من `setupAutoUpdater` عشان electron-updater يشتغل على الماك زي ويندوز.
