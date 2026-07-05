// public/init.js
// [SEC-FIX-13b] منقول من <script> inline بـ index.html حتى نقدر نشيل 'unsafe-inline'
// من CSP script-src بلا أي تغيير بالسلوك — نفس الكود بالضبط بدون أي تعديل منطقي.

window.addEventListener('load', function () {
  // Don't hide loader here - let init() hide it after auth check
});

window._hideLoader = function () {
  var l = document.getElementById('initial-loader');
  if (l) {
    l.style.opacity = '0';
    l.style.transition = 'opacity 0.3s ease';
    setTimeout(function () { if (l.parentNode) l.remove(); }, 300);
  }
  var nav = document.querySelector('.nav');
  var foot = document.querySelector('footer');
  if (nav) nav.style.cssText = 'visibility:visible;opacity:1;';
  if (foot) foot.style.cssText = 'visibility:visible;opacity:1;';
};
