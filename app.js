'use strict';
/* Oscar NAS - front end. Vanilla JS, no build step.

   Motion model (WeChat-like, deliberately restrained):
     - a 2px green hairline at the top of the viewport is the ONLY page-level
       loading indicator. No spinner card, no dimmed overlay, no fake modal.
     - row-level work (download / rename) shows a tiny spinner inside the button.
     - directory changes are a page turn: the outgoing list slides out to one
       side, the incoming list slides in from the other.
     - tapping a row tints the whole row grey. WeChat has no ripple.
*/

var API = window.WB.API;
var TOKEN_KEY = 'wb_nas_token';
var token = localStorage.getItem(TOKEN_KEY) || '';
var cwd = '';
var navLock = false;

var $ = function (id) { return document.getElementById(id); };

/* ------------------------------------------------------------------ toast */

function toast(msg, isErr) {
  var t = $('toast');
  t.textContent = msg;
  t.className = 'on' + (isErr ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { t.className = ''; }, isErr ? 3800 : 2000);
}

function shake(el, msg) {
  el.textContent = msg;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
}

/* ------------------------------------------------- top hairline progress bar */

var barDepth = 0;

function barStart() {
  barDepth++;
  if (barDepth > 1) return;                 /* already running: do not restart */
  var t = $('topbar'), i = t.firstElementChild;
  clearTimeout(barDone._t);
  t.classList.add('on');
  i.style.transition = 'none';
  i.style.opacity = '1';
  i.style.width = '0%';
  void i.offsetWidth;                       /* commit, so the reset reads as a change */
  i.style.transition = 'width .55s cubic-bezier(.2, .8, .3, 1)';
  i.style.width = '72%';                    /* creep towards, but never reach 100 */
}

function barDone() {
  barDepth = Math.max(0, barDepth - 1);
  if (barDepth) return;
  var t = $('topbar'), i = t.firstElementChild;
  i.style.transition = 'width .16s ease, opacity .3s ease .14s';
  i.style.width = '100%';
  i.style.opacity = '0';
  clearTimeout(barDone._t);
  barDone._t = setTimeout(function () { t.classList.remove('on'); }, 520);
}

/* -------------------------------------------------------------- page turn */

function reducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/* dir > 0 : going deeper -> old list leaves left,  new arrives from right
   dir < 0 : going back   -> old list leaves right, new arrives from left   */
/* BUG THIS FIXES (user reported it 2026-10-03 20:15: "click a folder, see the
 * files for a moment, then the page goes white and nothing is there").
 * Cause: the outgoing animation used fill:'forwards', so after it finished it
 * KEPT pinning the <ul> at opacity:0 / translateX(...). The incoming animation
 * played on top of that and looked correct while it ran -- then the instant it
 * ended, the older forwards-filled effect took over again and the list vanished.
 * Rule learned: never let two animations target the same property on the same
 * element unless you cancel the first one. */
var navAnim = null;

function navTo(path, dir) {
  if (navLock) return;
  navLock = true;
  var ul = $('list');

  var outF = dir > 0
    ? [{ transform: 'translateX(0)', opacity: 1 }, { transform: 'translateX(-28px)', opacity: 0 }]
    : [{ transform: 'translateX(0)', opacity: 1 }, { transform: 'translateX(28px)', opacity: 0 }];
  var inF = dir > 0
    ? [{ transform: 'translateX(28px)', opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }]
    : [{ transform: 'translateX(-28px)', opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }];

  function go() {
    /* drop the outgoing fill BEFORE repainting the rows, or it wins again */
    if (navAnim) { navAnim.cancel(); navAnim = null; }
    /* The row-by-row fade belongs to first paint and manual refresh only. During
       a page turn it plays on top of the slide, so the whole transition looks
       like it runs twice - which is exactly what the user reported when going
       past the first level. Turn it off for the duration of the turn. */
    ul.classList.add('no-row-anim');
    load(path).then(function () {
      if (reducedMotion()) return;
      navAnim = ul.animate(inF, { duration: 240, easing: 'cubic-bezier(.2, .8, .3, 1)' });
      return navAnim.finished;
    }).then(function () {
      if (navAnim) { navAnim.cancel(); navAnim = null; }
      ul.classList.remove('no-row-anim');
      navLock = false;
    }, function () {
      ul.classList.remove('no-row-anim');
      navLock = false;
    });
  }

  if (reducedMotion()) { go(); return; }
  navAnim = ul.animate(outF, { duration: 140, easing: 'cubic-bezier(.4, 0, .9, .5)', fill: 'forwards' });
  if (navAnim.finished && navAnim.finished.then) navAnim.finished.then(go, go);
  else navAnim.onfinish = go;
}

/* ---------------------------------------------------------------- transport */

function req(method, url, body, isForm) {
  barStart();
  return new Promise(function (resolve, reject) {
    var x = new XMLHttpRequest();
    x.open(method, API + url, true);
    if (token) x.setRequestHeader('Authorization', 'Bearer ' + token);
    if (body && !isForm) x.setRequestHeader('Content-Type', 'application/json');
    x.onload = function () {
      barDone();
      var d = {};
      try { d = JSON.parse(x.responseText); } catch (e) { }
      if (x.status === 401) { logout(true); reject(new Error('登入已過期，請重新登入')); return; }
      if (x.status >= 200 && x.status < 300) resolve(d);
      else reject(new Error(d.error || ('HTTP ' + x.status)));
    };
    x.onerror = function () { barDone(); reject(new Error('連不上 NAS，檢查網絡')); };
    x.send(body ? (isForm ? body : JSON.stringify(body)) : null);
  });
}

/* Wrap a click handler so the button can never be left spinning, and so every
   failure surfaces as a toast exactly once. */
function tap(btn, veilText, work) {
  return function (e) {
    if (btn && btn.classList.contains('busy')) return;
    if (veilText) btn.classList.add('busy');
    var done = function () { if (veilText) btn.classList.remove('busy'); };
    var fail = function (err) {
      done();
      toast(err && err.message ? err.message : String(err), true);
    };
    try {
      var r = work(e);
      if (r && typeof r.then === 'function') return r.then(function (v) { done(); return v; }, fail);
      done();
      return r;
    } catch (err) { fail(err); }
  };
}

function showSkeleton(n) {
  var ul = $('list');
  ul.classList.add('loading');
  ul.innerHTML = '';
  for (var i = 0; i < (n || 6); i++) {
    var li = document.createElement('li');
    li.className = 'skel';
    ul.appendChild(li);
  }
}

function hideSkeleton() { $('list').classList.remove('loading'); }

function mkBtn(cls, label, veilText, work) {
  var b = document.createElement('button');
  b.className = 'btn icon' + (cls ? ' ' + cls : '');
  b.innerHTML = '<span class="lbl"></span>';
  b.querySelector('.lbl').textContent = label;
  b.onclick = tap(b, veilText, work);
  return b;
}

/* ------------------------------------------------------------- file kinds */

function extOf(n) {
  var m = String(n).match(/\.([A-Za-z0-9]+)$/);
  return m ? m[1].toLowerCase() : '';
}

var KIND_EXT = {
  image: ['jpg', 'jpeg', 'jpe', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif', 'heic', 'tif', 'tiff'],
  video: ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi', '3gp'],
  audio: ['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac', 'opus', 'wma'],
  word:  ['doc', 'docx', 'rtf', 'odt'],
  ppt:   ['ppt', 'pptx', 'odp', 'key'],
  xls:   ['xls', 'xlsx', 'ods', 'numbers'],
  text:  ['txt', 'md', 'log', 'json', 'xml', 'js', 'css', 'ini', 'conf', 'yml', 'yaml', 'srt', 'csv'],
  zip:   ['zip', 'rar', '7z', 'gz', 'tar', 'bz2', 'xz', 'tgz'],
};

function kindOf(name) {
  var e = extOf(name);
  for (var k in KIND_EXT) { if (KIND_EXT[k].indexOf(e) >= 0) return k; }
  if (e === 'pdf') return 'pdf';
  return 'file';
}

var KIND_CLASS = {
  image: '', video: 't-video', audio: 't-audio', word: 't-word', ppt: 't-ppt',
  xls: 't-xls', pdf: 't-pdf', text: 't-text', zip: 't-zip', file: '', dir: 't-dir',
};

/* Inline SVG rather than emoji: emoji render differently on every platform and
   read as decoration instead of as a file type. */
var FILE_SVG =
  '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>' +
  '<path d="M14 3v5h5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>';
var LETTER = 'font-family="Arial,Helvetica,sans-serif" font-size="6.2" font-weight="700" text-anchor="middle" fill="currentColor"';

function fileIcon(kind) {
  if (kind === 'dir') {
    return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.8 6.6A1.6 1.6 0 0 1 4.4 5h4.3l1.9 2.3h9A1.6 1.6 0 0 1 21.2 8.9v8.5a1.6 1.6 0 0 1-1.6 1.6H4.4a1.6 1.6 0 0 1-1.6-1.6z"/></svg>';
  }
  if (kind === 'audio') {
    return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.2 17.4V6.1l9.6-1.9v11.3"/><circle cx="7.1" cy="17.5" r="2.7"/><circle cx="16.7" cy="15.3" r="2.7"/></svg>';
  }
  if (kind === 'video') {
    return '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="2.4" y="4.9" width="14.2" height="14.2" rx="2.4"/><path d="M17.8 10.1l3.8-2.3v8.4l-3.8-2.3z"/></svg>';
  }
  var inner = '';
  if (kind === 'word') inner = '<text x="12" y="16.6" ' + LETTER + '>W</text>';
  else if (kind === 'ppt') inner = '<text x="12" y="16.6" ' + LETTER + '>P</text>';
  else if (kind === 'xls') inner = '<text x="12" y="16.6" ' + LETTER + '>X</text>';
  else if (kind === 'pdf') inner = '<text x="12" y="16.6" ' + LETTER + '>PDF</text>';
  else if (kind === 'zip') inner = '<rect x="9.9" y="9.6" width="4.2" height="3.1" rx=".6" fill="currentColor"/><rect x="9.9" y="13.4" width="4.2" height="3.1" rx=".6" fill="currentColor"/>';
  else if (kind === 'text') inner = '<path d="M8.7 12.4h6.6M8.7 15.3h4.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>';
  return '<svg viewBox="0 0 24 24">' + FILE_SVG + inner + '</svg>';
}

function rawUrl(rel) { return API + '/api/raw?path=' + encodeURIComponent(rel) + '&t=' + encodeURIComponent(token); }
function dlUrl(rel) { return API + '/api/download?path=' + encodeURIComponent(rel); }

/* Real thumbnail for images, real first frame for video, drawn icon for the rest.
   Capped: a folder of 200 photos would otherwise pull 200 originals down a
   ~1.6 MB/s link just to render a list. */
var LIVE_THUMBS = 24;

function thumbFor(kind, rel, idx) {
  if (idx < LIVE_THUMBS) {
    if (kind === 'image') return '<img loading="lazy" alt="" src="' + rawUrl(rel) + '">';
    if (kind === 'video') return '<video preload="metadata" muted playsinline src="' + rawUrl(rel) + '#t=0.6"></video>';
  }
  return fileIcon(kind);
}

/* ----------------------------------------------------------------- preview */

var PREVIEWABLE = { image: 1, video: 1, audio: 1, text: 1, pdf: 1 };

var KIND_LABEL = {
  image: '圖片', video: '影片', audio: '音訊', pdf: 'PDF', word: 'Word 文件',
  ppt: 'PowerPoint', xls: 'Excel 檔', text: '文字檔', zip: '壓縮檔',
  dir: '資料夾', file: '檔案',
};

function inActions(e) {
  var n = e.target;
  while (n && n !== document.body) {
    if (n.classList && n.classList.contains('acts')) return true;
    n = n.parentNode;
  }
  return false;
}

var viewerRel = '';

function openViewer(rel, name, kind, size) {
  viewerRel = rel;
  var body = $('vBody');
  body.className = 'vbody';
  body.innerHTML = '';

  $('vTitle').textContent = name;
  $('vMeta').textContent = (KIND_LABEL[kind] || '檔案') + (size != null ? ' · ' + fmtSize(size) : '');
  $('vNote').textContent = '檔案直接從你的硬碟讀出，沒有經過任何外部服務。';

  if (kind === 'image') {
    body.innerHTML = '<img alt="" src="' + rawUrl(rel) + '">';
  } else if (kind === 'video') {
    body.innerHTML = '<video controls autoplay playsinline src="' + rawUrl(rel) + '"></video>';
  } else if (kind === 'audio') {
    body.innerHTML = '<audio controls autoplay src="' + rawUrl(rel) + '"></audio>';
  } else if (kind === 'pdf') {
    body.innerHTML = '<iframe src="' + rawUrl(rel) + '#toolbar=1" title="PDF 預覽"></iframe>';
  } else if (kind === 'text') {
    body.className = 'vbody sheet-pad';
    body.innerHTML = '<pre>讀取中…</pre>';
    fetch(rawUrl(rel), { headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) { return r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (t) { var pre = body.querySelector('pre'); if (pre) pre.textContent = t; })
      .catch(function (e) {
        body.innerHTML = '<div class="none"><div class="big">讀取失敗</div>' + e.message + '</div>';
      });
  } else {
    body.innerHTML = '<div class="none"><div class="big">這個格式沒法在網上預覽</div>' +
      '用下面的按鈕下載，或在新分頁開啟原始檔。</div>';
  }

  $('viewer').classList.add('on');
  $('viewer').setAttribute('aria-hidden', 'false');
}

function closeViewer() {
  var v = $('viewer');
  v.classList.remove('on');
  v.setAttribute('aria-hidden', 'true');
  $('vBody').innerHTML = '';          /* also stops any playing video/audio */
  viewerRel = '';
}

$('vClose').onclick = closeViewer;
$('viewer').onclick = function (e) { if (e.target === this) closeViewer(); };
$('vDl').onclick = function () { if (viewerRel) download(viewerRel); };
$('vOpen').onclick = function () { if (viewerRel) window.open(rawUrl(viewerRel), '_blank', 'noopener'); };
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && $('viewer').classList.contains('on')) closeViewer();
});

/* ------------------------------------------------------------------- format */

function fmtSize(n) {
  if (n == null) return '';
  var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + u[i];
}

function fmtDate(ms) {
  var d = new Date(ms), p = function (x) { return String(x).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/* --------------------------------------------------------------------- auth */

function logout(silent) {
  if (token) { req('POST', '/api/logout').catch(function () { }); }
  token = '';
  localStorage.removeItem(TOKEN_KEY);
  cwd = '';
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
  $('backBtn').disabled = true;
  $('navTitle').textContent = 'Oscar NAS';
  if (!silent) toast('已登出');
}

$('loginForm').addEventListener('submit', function (e) {
  e.preventDefault();
  var pw = $('pw').value;
  var btn = $('loginBtn');
  if (!pw) { shake($('loginErr'), '請輸入密碼'); $('pw').focus(); return; }
  btn.classList.add('busy');
  $('loginErr').textContent = '';
  req('POST', '/api/login', { password: pw })
    .then(function (d) {
      token = d.token;
      localStorage.setItem(TOKEN_KEY, token);
      $('pw').value = '';
      start();
    })
    .catch(function (err) {
      shake($('loginErr'), err.message === 'invalid'
        ? '密碼不對（連續 5 次會鎖 15 分鐘）' : err.message);
    })
    .finally(function () { btn.classList.remove('busy'); });
});

$('revealPw').addEventListener('click', function () {
  var i = $('pw');
  var show = i.type === 'password';
  i.type = show ? 'text' : 'password';
  this.textContent = show ? '隱藏' : '顯示';
  this.setAttribute('aria-label', show ? '隱藏密碼' : '顯示密碼');
  i.focus();
});

$('pw').addEventListener('input', function () {
  if ($('loginErr').textContent) $('loginErr').textContent = '';
});

/* -------------------------------------------------------------------- start */

function start() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  cwd = '';
  showSkeleton();
  load('');
}

function load(p) {
  showSkeleton();
  return req('GET', '/api/list?path=' + encodeURIComponent(p))
    .then(function (d) {
      cwd = d.path || '';
      renderCrumbs(cwd);
      renderList(d);
      return req('GET', '/api/disk?path=' + encodeURIComponent(cwd)).then(function (k) {
        $('disk').textContent = fmtSize(k.free) + ' 可用';
      }).catch(function () { });
    })
    .catch(function (e) {
      var ul = $('list');
      ul.innerHTML = '';
      var li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '讀取失敗：' + e.message;
      ul.appendChild(li);
    })
    .finally(function () { hideSkeleton(); });
}

/* ------------------------------------------------------------------- chrome */

function renderCrumbs(p) {
  var box = $('crumbs');
  box.innerHTML = '';

  var root = document.createElement('a');
  root.textContent = 'E:';
  root.onclick = function () { if (cwd) navTo('', -1); };
  box.appendChild(root);

  if (p) {
    var acc = '';
    p.split('/').filter(Boolean).forEach(function (seg) {
      acc = acc ? acc + '/' + seg : seg;
      var sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '/';
      box.appendChild(sep);
      var a = document.createElement('a');
      a.textContent = seg;
      var target = acc;
      a.onclick = function () { navTo(target, target.length < cwd.length ? -1 : 1); };
      box.appendChild(a);
    });
  }

  $('backBtn').disabled = !p;
  $('navTitle').textContent = p ? p.split('/').pop() : 'Oscar NAS';
}

$('backBtn').addEventListener('click', function () {
  if (!cwd) return;
  navTo(cwd.split('/').slice(0, -1).join('/'), -1);
});

/* --------------------------------------------------------------------- list */

function renderList(d) {
  var ul = $('list');
  ul.innerHTML = '';
  var all = d.dirs.concat(d.files);
  if (!all.length) {
    var e = document.createElement('li');
    e.className = 'empty';
    e.textContent = '（空文件夾）';
    ul.appendChild(e);
    return;
  }

  all.forEach(function (it, idx) {
    var rel = cwd ? cwd + '/' + it.name : it.name;
    var kind = it.dir ? 'dir' : kindOf(it.name);
    var li = document.createElement('li');
    li.className = 'tappable';
    li.style.setProperty('--i', String(Math.min(idx, 26)));

    var ic = document.createElement('span');
    ic.className = 'ico' + (KIND_CLASS[kind] ? ' ' + KIND_CLASS[kind] : '');
    ic.innerHTML = it.dir ? fileIcon('dir') : thumbFor(kind, rel, idx);
    li.appendChild(ic);

    var nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = it.name;
    li.appendChild(nm);

    if (!it.dir) {
      var sz = document.createElement('span');
      sz.className = 'sub size';
      sz.textContent = fmtSize(it.size);
      li.appendChild(sz);
    }

    var md = document.createElement('span');
    md.className = 'sub';
    md.textContent = fmtDate(it.mtime);
    li.appendChild(md);

    /* One handler for the whole row. The action buttons check themselves out of
       the way, so tapping anywhere else does the obvious thing. */
    li.onclick = function (e) {
      if (inActions(e)) return;
      if (it.dir) { navTo(rel, 1); return; }
      if (PREVIEWABLE[kind]) openViewer(rel, it.name, kind, it.size);
    };

    if (it.dir) {
      var chev = document.createElement('span');
      chev.className = 'chev';
      chev.textContent = '›';
      li.appendChild(chev);
    } else {
      var acts = document.createElement('span');
      acts.className = 'acts';
      if (PREVIEWABLE[kind]) {
        acts.appendChild(mkBtn('', '預覽', null, function () { openViewer(rel, it.name, kind, it.size); }));
      }
      acts.appendChild(mkBtn('', '下載', '下載中…', function () { return download(rel); }));
      acts.appendChild(mkBtn('', '改名', null, function () {
        var n = prompt('新名稱：', it.name);
        if (!n || n === it.name) return null;
        return req('POST', '/api/rename', { path: rel, newName: n })
          .then(function () { toast('已改名'); load(cwd); });
      }));
      acts.appendChild(mkBtn('danger', '刪除', null, function () {
        if (!confirm('確定刪除「' + it.name + '」？\n此操作無法復原。')) return null;
        return req('POST', '/api/delete', { path: rel })
          .then(function () { toast('已刪除'); load(cwd); });
      }));
      li.appendChild(acts);
    }

    ul.appendChild(li);
  });
}

/* ----------------------------------------------------------------- download */

function download(rel) {
  var url = API + '/api/download?path=' + encodeURIComponent(rel);
  return fetch(url, { headers: { Authorization: 'Bearer ' + token } })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    })
    .then(function (b) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = rel.split('/').pop();
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
      toast('已下載 ' + rel.split('/').pop());
    });
}

/* ------------------------------------------------------------------- upload */

$('upBtn').onclick = tap($('upBtn'), null, function () { $('files').click(); });

$('files').onchange = function () {
  var fs = Array.prototype.slice.call($('files').files);
  if (!fs.length) return;
  uploadNext(fs, 0);
  $('files').value = '';
};

function uploadNext(list, i) {
  if (i >= list.length) {
    $('prog').classList.add('hidden');
    $('upBtn').classList.remove('busy');
    load(cwd);
    return;
  }
  if (i === 0) $('upBtn').classList.add('busy');

  var f = list[i];
  var fd = new FormData();
  fd.append('files', f, f.name);

  var x = new XMLHttpRequest();
  x.open('POST', API + '/api/upload?path=' + encodeURIComponent(cwd), true);
  x.setRequestHeader('Authorization', 'Bearer ' + token);

  $('prog').classList.remove('hidden');
  $('progText').textContent = '上傳中 ' + (i + 1) + '/' + list.length + '：' + f.name + ' — ' + fmtSize(f.size);

  x.upload.onprogress = function (e) {
    if (!e.lengthComputable) return;
    var pct = Math.round(e.loaded / e.total * 100);
    $('progBar').style.width = pct + '%';
    $('progText').textContent = '上傳中 ' + (i + 1) + '/' + list.length + '：' + f.name + ' — ' + pct + '%';
  };

  x.onload = function () {
    if (x.status === 200) { uploadNext(list, i + 1); return; }
    var msg = 'HTTP ' + x.status;
    try { msg = JSON.parse(x.responseText).error || msg; } catch (e) { }
    $('prog').classList.add('hidden');
    $('upBtn').classList.remove('busy');
    toast('上傳失敗（' + f.name + '）：' + msg, true);
  };
  x.onerror = function () {
    $('prog').classList.add('hidden');
    $('upBtn').classList.remove('busy');
    toast('上傳中斷（' + f.name + '）', true);
  };
  x.send(fd);
}

/* ----------------------------------------------------------------- toolbar */

$('mkdirBtn').onclick = tap($('mkdirBtn'), null, function () {
  var n = prompt('新文件夾名稱：');
  if (!n) return null;
  return req('POST', '/api/mkdir', { path: cwd, name: n })
    .then(function () { toast('已建立'); load(cwd); });
});

$('refreshBtn').onclick = tap($('refreshBtn'), null, function () {
  return load(cwd).then(function () { toast('已重新整理'); });
});

$('logoutBtn').onclick = function () { logout(); };

/* --------------------------------------------------------------------- boot */

if (token) {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  showSkeleton();
  req('GET', '/api/whoami')
    .then(function () { return load(''); })
    .catch(function () {
      token = '';
      localStorage.removeItem(TOKEN_KEY);
      $('app').classList.add('hidden');
      $('login').classList.remove('hidden');
    });
} else {
  $('login').classList.remove('hidden');
}
