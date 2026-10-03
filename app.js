'use strict';
/* Oscar NAS - file manager front end. Vanilla JS, no build step. */

var API = window.WB.API;
var TOKEN_KEY = 'wb_nas_token';
var token = localStorage.getItem(TOKEN_KEY) || '';
var cwd = '';

var $ = function (id) { return document.getElementById(id); };

function toast(msg, isErr) {
  var t = $('toast');
  t.textContent = msg;
  t.className = 'on' + (isErr ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { t.className = ''; }, isErr ? 4200 : 2200);
}

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

/* ---------------------------------------------------------------- transport */

/* ----------------------------------------------------------- motion helpers */

/* A counter, not a boolean. Requests overlap (list + disk, a rename that
 * re-lists behind it) and the veil must only lift when the LAST one lands. */
var busyCount = 0;

function pushBusy(text) {
  busyCount++;
  if (text) $('busyText').textContent = text;
  $('busy').classList.add('on');
}

function popBusy() {
  busyCount = Math.max(0, busyCount - 1);
  if (!busyCount) $('busy').classList.remove('on');
}

function isBusy() { return busyCount > 0; }

/* Ripple from the exact tap point - the difference between "the page ignored
 * me" and "the page heard me". Costs one span and one timeout. */
function ripple(el, e) {
  if (!el || !el.classList || !el.classList.contains('btn')) return;
  var r = el.getBoundingClientRect();
  var d = Math.max(r.width, r.height) * 1.1;
  var s = document.createElement('span');
  s.className = 'ripple';
  s.style.width = s.style.height = d + 'px';
  var cx = (e && e.clientX) ? e.clientX - r.left : r.width / 2;
  var cy = (e && e.clientY) ? e.clientY - r.top : r.height / 2;
  s.style.left = (cx - d / 2) + 'px';
  s.style.top = (cy - d / 2) + 'px';
  el.appendChild(s);
  setTimeout(function () { if (s.parentNode) s.parentNode.removeChild(s); }, 600);
}

/* Wrap a click handler: ripple on frame one, spinner + veil while it works,
 * errors surfaced as a toast, and the button is NEVER left stuck - even if the
 * handler throws synchronously. */
function tap(btn, veilText, work) {
  return function (e) {
    ripple(btn, e);
    if (btn && btn.classList.contains('busy')) return;
    var heavy = !!veilText;
    if (heavy) { btn.classList.add('busy'); pushBusy(veilText); }
    var done = function () { if (heavy) { btn.classList.remove('busy'); popBusy(); } };
    var fail = function (err) {
      done();
      toast(err && err.message ? err.message : String(err), true);
    };
    try {
      var r = work(e);
      if (r && typeof r.then === 'function') {
        return r.then(function (v) { done(); return v; }, fail);
      }
      done();
      return r;
    } catch (err) { fail(err); }
  };
}

function shake(el, msg) {
  el.textContent = msg;
  el.classList.remove('show');
  void el.offsetWidth;                 /* force reflow so the animation replays */
  el.classList.add('show');
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

/* Small labelled button whose label fades out while it works. */
function mkBtn(cls, label, veilText, work) {
  var b = document.createElement('button');
  b.className = 'btn icon' + (cls ? ' ' + cls : '');
  b.innerHTML = '<span class="lbl"></span>';
  b.querySelector('.lbl').textContent = label;
  b.onclick = tap(b, veilText, work);
  return b;
}

function req(method, url, body, isForm) {
  return new Promise(function (resolve, reject) {
    var x = new XMLHttpRequest();
    x.open(method, API + url, true);
    if (token) x.setRequestHeader('Authorization', 'Bearer ' + token);
    if (body && !isForm) x.setRequestHeader('Content-Type', 'application/json');
    x.onload = function () {
      var d = {};
      try { d = JSON.parse(x.responseText); } catch (e) { }
      if (x.status === 401) { logout(true); reject(new Error('登入已過期，請重新登入')); return; }
      if (x.status >= 200 && x.status < 300) resolve(d);
      else reject(new Error(d.error || ('HTTP ' + x.status)));
    };
    x.onerror = function () { reject(new Error('連不上 NAS，檢查網絡')); };
    x.send(body ? (isForm ? body : JSON.stringify(body)) : null);
  });
}

/* --------------------------------------------------------------------- auth */

function logout(silent) {
  if (token) { req('POST', '/api/logout').catch(function () { }); }
  token = '';
  localStorage.removeItem(TOKEN_KEY);
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
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

/* Show / hide the password without leaving the keyboard, and clear a stale
 * error the moment they start typing again. */
$('revealPw').addEventListener('click', function (e) {
  ripple(this, e);
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
  pushBusy('載入硬盤中…');
  load('').finally(function () { popBusy(); });
}

function load(p) {
  showSkeleton();
  $('disk').classList.add('loading');
  return req('GET', '/api/list?path=' + encodeURIComponent(p))
    .then(function (d) {
      cwd = d.path || '';
      renderCrumbs(cwd);
      renderList(d);
      return req('GET', '/api/disk?path=' + encodeURIComponent(cwd)).then(function (k) {
        $('disk').textContent = fmtSize(k.free) + ' 可用 / ' + fmtSize(k.total);
      }).catch(function () { });
    })
    .catch(function (e) {
      var ul = $('list');
      ul.innerHTML = '';
      var li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '讀取失敗：' + e.message;
      ul.appendChild(li);
      toast(e.message, true);
    })
    .finally(function () {
      hideSkeleton();
      $('disk').classList.remove('loading');
    });
}

function renderCrumbs(p) {
  var box = $('crumbs');
  box.innerHTML = '';
  var root = document.createElement('a');
  root.textContent = 'E:';
  root.onclick = function () { load(''); };
  box.appendChild(root);

  if (!p) return;
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
    a.onclick = function () { load(target); };
    box.appendChild(a);
  });
}

function renderList(d) {
  var ul = $('list');
  ul.innerHTML = '';
  var all = d.dirs.concat(d.files);
  if (!all.length) {
    var li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '（空文件夾）';
    ul.appendChild(li);
    return;
  }

  all.forEach(function (it, idx) {
    var li = document.createElement('li');
    li.style.setProperty('--i', String(Math.min(idx, 26)));

    var nm = document.createElement('div');
    nm.className = 'nm' + (it.dir ? ' dir' : '');
    nm.textContent = (it.dir ? '📁 ' : '📄 ') + it.name;
    var rel = cwd ? cwd + '/' + it.name : it.name;
    nm.onclick = function () {
      if (it.dir) {
        if (isBusy()) return;
        pushBusy('載入中…');
        load(rel).finally(popBusy);
      } else {
        download(rel).catch(function (e) { toast('下載失敗：' + e.message, true); });
      }
    };
    li.appendChild(nm);

    var ms = document.createElement('div');
    ms.className = 'meta size';
    ms.textContent = it.dir ? '' : fmtSize(it.size);
    li.appendChild(ms);

    var md = document.createElement('div');
    md.className = 'meta';
    md.textContent = fmtDate(it.mtime);
    li.appendChild(md);

    var acts = document.createElement('div');
    acts.className = 'acts';

    if (!it.dir) {
      acts.appendChild(mkBtn('', '下載', '下載中…', function () { return download(rel); }));
    }

    acts.appendChild(mkBtn('', '改名', null, function () {
      var n = prompt('新名稱：', it.name);
      if (!n || n === it.name) return null;
      return req('POST', '/api/rename', { path: rel, newName: n })
        .then(function () { toast('已改名'); return load(cwd); });
    }));

    acts.appendChild(mkBtn('danger', '刪除', null, function () {
      var what = it.dir ? '整個文件夾（連內容）' : '檔案';
      if (!confirm('確定刪除「' + it.name + '」' + what + '？\n此操作無法復原。')) return null;
      return req('POST', '/api/delete', { path: rel })
        .then(function () { toast('已刪除'); return load(cwd); });
    }));

    li.appendChild(acts);
    ul.appendChild(li);
  });
}

function download(rel) {
  /* Fetch it here rather than handing the browser a bare link, so the button can
   * show a spinner and we can surface a real error instead of a silent nothing. */
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
    if (x.status === 200) { uploadNext(list, i + 1); }
    else {
      var msg = 'HTTP ' + x.status;
      try { msg = JSON.parse(x.responseText).error || msg; } catch (e) { }
      $('prog').classList.add('hidden');
      $('upBtn').classList.remove('busy');
      toast('上傳失敗（' + f.name + '）：' + msg, true);
    }
  };
  x.onerror = function () {
    $('prog').classList.add('hidden');
    $('upBtn').classList.remove('busy');
    toast('上傳中斷（' + f.name + '）', true);
  };
  x.send(fd);
}

/* --------------------------------------------------------------- new folder */

$('mkdirBtn').onclick = tap($('mkdirBtn'), null, function () {
  var n = prompt('新文件夾名稱：');
  if (!n) return null;
  return req('POST', '/api/mkdir', { path: cwd, name: n })
    .then(function () { toast('已建立'); return load(cwd); });
});

$('refreshBtn').onclick = tap($('refreshBtn'), null, function () {
  return load(cwd).then(function () { toast('已重新整理'); });
});

$('logoutBtn').onclick = tap($('logoutBtn'), null, function () { logout(); });

/* -------------------------------------------------------------------- boot */

if (token) {
  pushBusy('驗證中…');
  req('GET', '/api/whoami')
    .then(start)
    .catch(function () {
      token = '';
      localStorage.removeItem(TOKEN_KEY);
      $('app').classList.add('hidden');
      $('login').classList.remove('hidden');
    })
    .finally(popBusy);
} else {
  $('login').classList.remove('hidden');
}
