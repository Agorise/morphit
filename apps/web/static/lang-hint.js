// Applies a ?lang= hint to <html lang/dir> before the page paints (an external
// file so the site's Content-Security-Policy needs no 'unsafe-inline').
(function () {
	try {
		var q = new URLSearchParams(window.location.search);
		var code = q.get('lang');
		if (!code) return;
		var allowed = ['en', 'es', 'de', 'pl', 'fr', 'it', 'ru', 'fa', 'zh-CN', 'zh-HK'];
		if (allowed.indexOf(code) === -1) return;
		document.documentElement.lang = code;
		document.documentElement.dir = code === 'fa' ? 'rtl' : 'ltr';
	} catch (_e) {
		/* no hint applied */
	}
})();
