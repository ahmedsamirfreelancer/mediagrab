(function () {
  const $ = (id) => document.getElementById(id);
  const keyInput = $('license-key');
  const activateBtn = $('activate-btn');
  const quitBtn = $('quit-btn');
  const buyLink = $('buy-link');
  const msg = $('msg');
  const fingerprintEl = $('fingerprint');

  function showMsg(type, text) {
    msg.className = 'msg ' + type;
    msg.textContent = text;
  }

  function clearMsg() { msg.className = 'msg'; msg.textContent = ''; }

  async function activate() {
    const key = (keyInput.value || '').trim();
    if (!key) {
      keyInput.focus();
      return;
    }
    activateBtn.disabled = true;
    activateBtn.textContent = 'جاري التفعيل...';
    clearMsg();
    try {
      const res = await window.licenseAPI.activate(key);
      if (res.success) {
        showMsg('success', res.message || 'تم التفعيل بنجاح، جاري فتح التطبيق...');
        // main.js will close this window once activate resolves successfully.
      } else {
        showMsg('error', res.message || 'فشل التفعيل');
        activateBtn.disabled = false;
        activateBtn.textContent = 'تفعيل';
      }
    } catch (e) {
      showMsg('error', e?.message || 'خطأ غير متوقع');
      activateBtn.disabled = false;
      activateBtn.textContent = 'تفعيل';
    }
  }

  activateBtn.addEventListener('click', activate);
  keyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') activate();
  });
  quitBtn.addEventListener('click', () => window.licenseAPI.quit());
  buyLink.addEventListener('click', () => window.licenseAPI.openExternal('https://arqami.app'));

  // Show machine ID so support can issue a tied license if needed.
  window.licenseAPI.getFingerprint().then((fp) => {
    fingerprintEl.textContent = 'Machine ID: ' + fp;
  }).catch(() => {});

  keyInput.focus();
})();
