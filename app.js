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
  if (!pw) return;
  $('loginBtn').disabled = true;
  $('loginErr').textContent = '';
  req('POST', '/api/login', { password: pw })
    .then(function (d) {
      token = d.token;
      localStorage.setItem(TOKEN_KEY, token);
      $('pw').value = '';
      start();
    })
    .catch(function (err) {
      $('loginErr').textContent = err.message === 'invalid'
        ? '密碼不對（連續 5 次會鎖 15 分鐘）' : err.message;
    })
    .finally(function () { $('loginBtn').disabled = false; });
});

/* -------------------------------------------------------------------- start */

function start() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  cwd = '';
  load('');
}

function load(p) {
  req('GET', '/api/list?path=' + encodeURIComponent(p))
    .then(function (d) {
      cwd = d.path || '';
      renderCrumbs(cwd);
      renderList(d);
      req('GET', '/api/disk?path=' + encodeURIComponent(cwd)).then(function (k) {
        $('disk').textContent = fmtSize(k.free) + ' 可用 / ' + fmtSize(k.total);
      }).catch(function () { });
    })
    .catch(function (e) { toast(e.message, true); });
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

  all.forEach(function (it) {
    var li = document.createElement('li');

    var nm = document.createElement('div');
    nm.className = 'nm' + (it.dir ? ' dir' : '');
    nm.textContent = (it.dir ? '📁 ' : '📄 ') + it.name;
    var rel = cwd ? cwd + '/' + it.name : it.name;
    nm.onclick = function () { it.dir ? load(rel) : download(rel); };
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
      var bd = document.createElement('button');
      bd.className = 'btn icon';
      bd.textContent = '下載';
      bd.onclick = function () { download(rel); };
      acts.appendChild(bd);
    }

    var br = document.createElement('button');
    br.className = 'btn icon';
    br.textContent = '改名';
    br.onclick = function () {
      var n = prompt('新名稱：', it.name);
      if (!n || n === it.name) return;
      req('POST', '/api/rename', { path: rel, newName: n })
        .then(function () { toast('已改名'); load(cwd); })
        .catch(function (e) { toast(e.message, true); });
    };
    acts.appendChild(br);

    var bx = document.createElement('button');
    bx.className = 'btn icon danger';
    bx.textContent = '刪除';
    bx.onclick = function () {
      var what = it.dir ? '整個文件夾（連內容）' : '檔案';
      if (!confirm('確定刪除「' + it.name + '」' + what + '？\n此操作無法復原。')) return;
      req('POST', '/api/delete', { path: rel })
        .then(function () { toast('已刪除'); load(cwd); })
        .catch(function (e) { toast(e.message, true); });
    };
    acts.appendChild(bx);

    li.appendChild(acts);
    ul.appendChild(li);
  });
}

function download(rel) {
  /* Direct link so the browser handles the download and can resume. */
  toast('開始下載…');
  var url = API + '/api/download?path=' + encodeURIComponent(rel);
  fetch(url, { headers: { Authorization: 'Bearer ' + token } })
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
    })
    .catch(function (e) { toast('下載失敗：' + e.message, true); });
}

/* ------------------------------------------------------------------- upload */

$('upBtn').onclick = function () { $('files').click(); };

$('files').onchange = function () {
  var fs = Array.prototype.slice.call($('files').files);
  if (!fs.length) return;
  uploadNext(fs, 0);
  $('files').value = '';
};

function uploadNext(list, i) {
  if (i >= list.length) {
    $('prog').classList.add('hidden');
    load(cwd);
    return;
  }
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
      toast('上傳失敗（' + f.name + '）：' + msg, true);
    }
  };
  x.onerror = function () {
    $('prog').classList.add('hidden');
    toast('上傳中斷（' + f.name + '）', true);
  };
  x.send(fd);
}

/* --------------------------------------------------------------- new folder */

$('mkdirBtn').onclick = function () {
  var n = prompt('新文件夾名稱：');
  if (!n) return;
  req('POST', '/api/mkdir', { path: cwd, name: n })
    .then(function () { toast('已建立'); load(cwd); })
    .catch(function (e) { toast(e.message, true); });
};

$('refreshBtn').onclick = function () { load(cwd); toast('已重新整理'); };
$('logoutBtn').onclick = function () { logout(); };

/* -------------------------------------------------------------------- boot */

if (token) {
  req('GET', '/api/whoami').then(start).catch(function () {
    token = '';
    localStorage.removeItem(TOKEN_KEY);
  });
} else {
  $('login').classList.remove('hidden');
}
