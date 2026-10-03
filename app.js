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

/* Images go through /api/thumb, which shrinks them ON the machine that holds
   the disk (ffmpeg) and caches the result. That is the whole difference between
   "ten seconds per photo" and "one second".

   The SIZE of that thumbnail is a SETTING, and the setting lives on the NAS box
   (see the settings section at the bottom of this file) - not in this browser.
   So it is read once at startup, from the server, and everything below just
   reads the resulting value. */
function thumbEdge() {
  return SETTINGS.thumbW || DEFAULTS.thumbW;
}

function thumbUrl(rel, edge) {
  return API + '/api/thumb?path=' + encodeURIComponent(rel) + '&w=' + (edge || thumbEdge()) +
         '&t=' + encodeURIComponent(token);
}

/* Real thumbnails are handled by the serial queue further down, not here. */

/* Mirrors BROWSER_ONLY in nas-server/server.js. The machine that holds the disk
   can decode JPEG/PNG/WebP/GIF/BMP but not HEIC or camera RAW; the browser often
   can. So when the box refuses to make a cover, these are the ONLY formats worth
   re-fetching at full size - for anything else a refusal means the file itself is
   damaged and the original would just be megabytes of the same broken picture. */
var BROWSER_ONLY = /\.(heic|heif|dng|cr2|cr3|nef|arw|raf|orf|rw2|srw|pef)$/i;

/* ----------------------------------------------------------------- preview */

var PREVIEWABLE = { image: 1, video: 1, audio: 1, text: 1, pdf: 1, word: 1, ppt: 1, xls: 1 };

/* Microsoft Office Web Viewer - free, no API key, no registration, no account.
 * Two hard limits, both handled here rather than by discovering them as an
 * error inside Microsoft's iframe:
 *   - 10 MB per document
 *   - the file must be reachable from the public internet, which is why
 *     /api/share mints a signed link that dies after 5 minutes. */
var OFFICE_KINDS = { word: 1, ppt: 1, xls: 1 };
var OFFICE_MAX = 10 * 1024 * 1024;
var OFFICE_VIEWER = 'https://view.officeapps.live.com/op/embed.aspx?src=';

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

/* Same spinner, same icon, same colours as the rest of the site - waiting on a
 * third-party viewer should still look like part of this app. */
function vloading(kind, text, withBar) {
  return '<div class="vload"><div class="spin lg"></div>' +
         '<div class="ic ' + (KIND_CLASS[kind] || '') + '">' + fileIcon(kind) + '</div>' +
         '<div class="tx">' + text + '</div>' +
         (withBar ? '<div class="lbar"><i></i></div>' : '') + '</div>';
}

/* Fetch an image into memory with a real percentage, and only hand it over once
   it is COMPLETE. A plain <img src> paints the parts that have arrived, top to
   bottom, against whatever the background is - the user sees a black rectangle
   with a half-drawn photo in it. Nothing partial ever reaches the screen. */
function loadImageProgress(url, onProgress, onDone) {
  var x = new XMLHttpRequest();
  x.open('GET', url, true);
  x.responseType = 'blob';
  x.onprogress = function (e) {
    if (e.lengthComputable && e.total) onProgress(Math.round(e.loaded / e.total * 100));
  };
  x.onload = function () {
    if (x.status >= 200 && x.status < 300 && x.response && x.response.size) {
      onDone(true, URL.createObjectURL(x.response));
    } else { onDone(false, null); }
  };
  x.onerror = function () { onDone(false, null); };
  x.ontimeout = function () { onDone(false, null); };
  x.send();
}

function openViewer(rel, name, kind, size) {
  viewerRel = rel;
  var body = $('vBody');
  body.className = 'vbody';
  body.innerHTML = '';

  $('vTitle').textContent = name;
  $('vMeta').textContent = (KIND_LABEL[kind] || '檔案') + (size != null ? ' · ' + fmtSize(size) : '');
  $('vNote').textContent = '檔案直接從你的硬碟讀出，沒有經過任何外部服務。';

  if (kind === 'image') {
    /* Show the loading face with a real percentage, then swap in the picture
       only once every byte has arrived. No black rectangle, no half-drawn photo. */
    body.innerHTML = vloading('image', '正在下載完整圖片…', true);
    var bar = body.querySelector('.lbar i');
    var lbl = body.querySelector('.tx');
    loadImageProgress(rawUrl(rel),
      function (pct) {
        if (bar) bar.style.width = pct + '%';
        if (lbl) lbl.textContent = '正在下載完整圖片… ' + pct + '%';
      },
      function (ok, url) {
        if (!ok) {
          body.innerHTML = '<div class="none"><div class="big">圖片載入失敗</div>' +
            '可能是檔案太大或網路中斷，再試一次。</div>';
          return;
        }
        var full = new Image();
        full.alt = '';
        full.onload = function () {
          body.innerHTML = '';
          body.className = 'vbody';
          body.appendChild(full);
          URL.revokeObjectURL(url);
        };
        full.onerror = function () { URL.revokeObjectURL(url); };
        full.src = url;
      });
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
  } else if (OFFICE_KINDS[kind]) {
    if (size != null && size > OFFICE_MAX) {
      /* Checked BEFORE asking for a share link: no point minting a public URL
       * for a document Microsoft is going to refuse anyway. */
      body.innerHTML = '<div class="none">' +
        '<div class="ic ' + (KIND_CLASS[kind] || '') + '">' + fileIcon(kind) + '</div>' +
        '<div class="big">這個檔案超過 10 MB</div>' +
        '微軟的線上預覽最多處理 10 MB（這個是 ' + fmtSize(size) + '）。<br>' +
        '請用下面的按鈕下載，再用電腦上的 Office 開啟。</div>';
    } else {
      body.innerHTML = vloading(kind, '正在開啟 Office 在線預覽…');
      req('GET', '/api/share?path=' + encodeURIComponent(rel))
        .then(function (d) {
          body.innerHTML = '<iframe src="' + OFFICE_VIEWER + encodeURIComponent(d.url) +
                           '" title="Office 預覽"></iframe>';
        })
        .catch(function (e) {
          body.innerHTML = '<div class="none"><div class="big">無法開啟在線預覽</div>' +
            e.message + '</div>';
        });
    }
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

/* ------------------------------------------------------------- disk banner

   The exposed drive is a USB disk and it WILL get yanked. Rather than let every
   request fail with a raw 500, poll one cheap unauthenticated endpoint and say
   so in plain language. Polling only continues while the disk is missing. */

var diskTimer = null;

function checkDisk() {
  fetch(API + '/api/health')
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var el = $('diskbar');
      if (d.disk === 'connected') {
        el.classList.add('hidden');
        if (diskTimer) { clearInterval(diskTimer); diskTimer = null; }
      } else {
        el.classList.remove('hidden');
        if (!diskTimer) diskTimer = setInterval(checkDisk, 8000);
      }
    })
    .catch(function () { });
}

/* -------------------------------------------------------------- thumbnails

   THE RULE, and it is the whole design: every row that has a cover WILL get
   one, in document order, all the way to the bottom of the folder, without the
   user having to keep scrolling and without anybody needing to know which rows
   happen to be on screen.

   The old engine was built the other way round. A row only entered the queue
   when an IntersectionObserver said "this one is visible", and the only thing
   that ever looked further ahead was the enqueue path itself. So the frontier
   was pinned to the deepest row ever seen plus a fixed look-ahead, no matter
   that background downloading was switched on. Scroll 15 rows in and stop, and
   the count froze at 15 for ever - exactly what the user reported.

   The new engine keeps an explicit ordered registry of every thumbnail row and
   walks it with ONE cursor:
     - every row paints its drawn type icon immediately, costing zero requests
     - the observer only RECORDS visibility (it feeds the status text), and in
       "只下載看得到的" mode it is what admits a row to the queue at all
     - driveThumbs() is the single driver. It tops the queue up to
       parallel x WINDOW rows from the cursor onwards, and when the cursor
       reaches the last loaded row it pulls the next page of the folder and
       carries straight on
     - a completed fetch, a page arriving, a settings change and an observer
       callback all do the same thing: call driveThumbs() again
   One driver, one cursor, one direction: down.                                */

var thumbRows = [];        /* every row that should carry a cover, document order */
var thumbCursor = 0;       /* how far down thumbRows[] the sweep has reached      */
var thumbQueue = [];
var thumbRunning = 0;
var thumbObserver = null;
var thumbGen = 0;          /* resetThumbs() bumps it; fetches from the old folder bail */
var thumbsDone = 0;        /* rows needing no cover, plus covers already settled   */
var thumbsTotal = 0;       /* rows created so far - grows as further pages arrive  */

/* How many rows beyond the parallel slots to keep queued. Three screens' worth
   is enough that a fast scroll never catches an empty queue, and small enough
   that leaving a folder does not strand a long tail of orphans. */
var THUMB_WINDOW = 3;
/* Consecutive failed page loads. Stops the sweep from hammering a broken
   listing request once per completed thumbnail. */
var moreFails = 0;

/* Three at a time by default. The user originally asked for one-at-a-time
   because twenty 300 KB originals were interleaving and leaving half-read files.
   A thumbnail is ~10 KB now, so the pipe is not the constraint any more - the
   800 ms round trip is - and serialising it just made a 25-photo folder take 25
   seconds. How many run at once is now a SETTING (on the NAS box), so the user
   can turn it down on a bad connection without waiting for a new release. */
function thumbParallel() {
  var n = parseInt(SETTINGS.thumbParallel, 10);
  return (n >= 1 && n <= 8) ? n : DEFAULTS.thumbParallel;
}

function resetThumbs() {
  thumbGen++;                        /* anything already in flight is now stale */
  thumbRows = [];
  thumbCursor = 0;
  thumbQueue.length = 0;
  thumbRunning = 0;
  thumbsDone = 0;
  thumbsTotal = 0;
  moreFails = 0;
  if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null }
  var m = $('more');
  if (m) { m.classList.add('hidden'); m.textContent = ''; }
  var b = $('progbar');
  if (b) b.classList.add('hidden');
}

/* Called by buildRow for every row it creates, in document order.
   thumbsTotal is incremented HERE and nowhere else: exactly one increment per
   row, so thumbsDone can never outrun it. The old engine also seeded the total
   with the folder's file count and then incremented again inside the queue,
   which is why the bar used to stall in the nineties and could never finish. */
function trackThumbRow(li) {
  thumbRows.push(li);
  thumbsTotal++;
}

function watchThumbs() {
  var rows = document.querySelectorAll('#list li[data-thumb]:not([data-done])');
  if (!rows.length) { driveThumbs(); return; }
  if (!('IntersectionObserver' in window)) {          /* old browser: no laziness available */
    Array.prototype.forEach.call(rows, function (li) { li.dataset.visible = '1'; });
    driveThumbs();
    return;
  }
  if (!thumbObserver) {
    thumbObserver = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var li = entries[i].target;
        if (entries[i].isIntersecting) {
          li.dataset.visible = '1';
        } else {
          li.dataset.visible = '';
          /* In "只下載看得到的" mode a row that scrolls away before its turn
             gives its slot back to whatever is actually on screen. In the
             normal mode it keeps its place - the sweep is going to reach it
             anyway, and dropping and re-fetching it would just be churn. */
          if (!SETTINGS.autoPreload) dropThumb(li);
        }
      }
      driveThumbs();
    }, { rootMargin: '320px 0px' });                 /* start a bit before it is on screen */
  }
  Array.prototype.forEach.call(rows, function (li) { thumbObserver.observe(li); });
  driveThumbs();
}

/* ------------------------------------------------------- the one driver ---

   Everything funnels through here. It is deliberately cheap and idempotent to
   call: it walks the registry from the cursor, hands the next rows to the
   queue, and when it runs off the end of what is loaded it asks for more of the
   folder. Nothing else in this file decides what downloads next.

   Background downloading is the default and is switchable from the settings
   screen on the NAS box, so a metered connection can be told to stop at what is
   actually on screen. */

/* Next row at or after the cursor that still needs a cover. Returns null when
   everything loaded so far is settled or already queued. The cursor only moves
   forward, and only past rows that are genuinely finished with - a row that is
   merely waiting in the queue keeps its position so it is not skipped. */
function nextThumbRow() {
  while (thumbCursor < thumbRows.length) {
    var r = thumbRows[thumbCursor];
    if (!r.isConnected || r.dataset.done === '1' || r.dataset.queued === '1') { thumbCursor++; continue; }
    return r;
  }
  return null;
}

function driveThumbs() {
  if (!SETTINGS.autoPreload) {
    /* "只下載看得到的": the sweep is not allowed to run ahead of the screen, so
       serve exactly the rows the observer has marked as visible. Anything the
       sweep had already queued ahead of the screen is given back, which is what
       makes switching this on mid-folder take effect at once. */
    for (var q = thumbQueue.length - 1; q >= 0; q--) {
      if (thumbQueue[q].dataset.visible !== '1') { thumbQueue[q].dataset.queued = ''; thumbQueue.splice(q, 1); }
    }
    for (var v = 0; v < thumbRows.length; v++) {
      if (thumbRows[v].dataset.visible === '1') enqueueThumb(thumbRows[v]);
    }
    paintThumbs();
    pumpThumbs(thumbParallel());
    return;
  }

  /* Keep at most parallel x THUMB_WINDOW covers in flight-or-waiting, taken
     strictly in document order - top of the list first, always. */
  var budget = Math.max(1, thumbParallel() * THUMB_WINDOW);
  while (thumbQueue.length + thumbRunning < budget) {
    var row = nextThumbRow();
    if (row) { enqueueThumb(row); thumbCursor++; continue; }
    /* Nothing left loaded that still needs work. If the folder has further pages
       and the last attempt did not fail, pull one; it comes back through
       appendFiles -> watchThumbs -> driveThumbs, so the sweep resumes itself. */
    if (listHasMore && !listBusy && moreFails < 2) loadMore();
    break;
  }
  paintThumbs();
  pumpThumbs(thumbParallel());
}

/* Pure bookkeeping. It does not fetch and it does not re-enter the driver, so
   the driver stays the only thing that decides what happens next. */
function enqueueThumb(li) {
  if (!li || li.dataset.done === '1' || li.dataset.queued === '1') return;
  li.dataset.queued = '1';
  thumbQueue.push(li);
}

function dropThumb(li) {
  if (!li || li.dataset.done === '1' || li.dataset.queued !== '1') return;
  var i = thumbQueue.indexOf(li);
  if (i >= 0) { thumbQueue.splice(i, 1); li.dataset.queued = ''; }
}

function pumpThumbs(par) {
  var n = par || thumbParallel();
  while (thumbRunning < n && thumbQueue.length) {
    var li = thumbQueue.shift();
    if (!li.isConnected || li.dataset.done === '1') { li.dataset.queued = ''; continue; }
    thumbRunning++;
    /* dataset.queued stays set for the whole flight, so the cursor can never
       hand the same row out twice while its request is still open. It is the
       completion callback below that clears it. */
    fetchThumb(li, thumbGen, function () {
      li.dataset.queued = '';
      /* Clamped. A completion arriving after the folder changed used to be able
         to drive this negative, which made the pump believe it had free slots it
         did not have - and then the queue simply stopped moving. */
      thumbRunning = Math.max(0, thumbRunning - 1);
      paintThumbs();
      driveThumbs();
    });
  }
  paintThumbs();
}

function fetchThumb(li, gen, next) {
  var kind = li.dataset.kind, rel = li.dataset.thumb, box = li.querySelector('.ico');
  var settled = false;
  var timer = null;
  var bail = null;                       /* object URL to release if we stand down */

  var settle = function () {
    if (settled) return;
    settled = true;
    if (timer) { clearTimeout(timer); timer = null; }
    /* The user changed folder or refreshed while this was still in flight. The
       row is detached and the counters already belong to the next folder, so
       touching any of them now would corrupt the new numbers. Give the slot
       back and leave quietly. */
    if (gen !== thumbGen) {
      if (bail) { try { URL.revokeObjectURL(bail); } catch (e) { } }
      next();
      return;
    }
    /* A row is marked done whether the cover arrived or not, so a file the NAS
       box cannot render (corrupt JPEG, ffmpeg missing and no video decoder) is
       attempted once instead of being retried on every sweep. */
    li.dataset.done = '1';
    thumbsDone++;
    paintThumbs();
    next();
  };

  /* A request that never comes back must not hold one of the parallel slots for
     ever - that is what made the count sit still at 15 instead of advancing. */
  timer = setTimeout(function () { settle(); }, 25000);

  /* A row whose cover could not be made - the file is damaged, or it is a format
     neither the box nor this browser can decode. Marked rather than left blank:
     an empty square that never fills in looks like the app is still working on
     it, and the user's whole complaint was not being able to tell what had
     actually loaded. Costs no requests. */
  var noCover = function () {
    li.dataset.nocover = '1';
    li.title = '封面做不出來：這個檔案可能已損壞，或者瀏覽器不支援這個格式';
  };

  if (kind === 'image' || kind === 'video') {
    /* The NAS box makes the thumbnail itself - ffmpeg, which also handles video
       frames. So both kinds are just an <img> now. Video used to need a <video>
       element reading megabytes of the file before a frame appeared, which is
       exactly why videos never showed a cover. */
    var img = new Image();
    img.alt = '';
    var usedVideoFallback = false;
    img.onload = function () { if (!settled) { box.textContent = ''; box.appendChild(img); } settle(); };
    img.onerror = function () {
      if (kind === 'video' && !usedVideoFallback) {
        /* No ffmpeg on the box: fall back to letting the browser decode a frame.
           Slow, but a cover beats an icon. preload='metadata' means only the
           header is fetched, so this stays cheap even for a huge movie. */
        usedVideoFallback = true;
        var v = document.createElement('video');
        v.muted = true; v.playsInline = true; v.preload = 'metadata';
        v.onloadeddata = function () { try { v.currentTime = 0.1; } catch (e) { } };
        v.onseeked = function () { if (!settled) { box.textContent = ''; box.appendChild(v); } settle(); };
        v.onerror = function () { noCover(); settle(); };
        v.src = rawUrl(rel);
        return;
      }
      /* The box refused. For the formats it cannot read at all (HEIC, camera
         RAW) the browser may still manage, so try the original once. For
         everything else - .jpg/.png/.webp, formats the box certainly can read -
         a refusal means the FILE is damaged, and re-fetching the whole thing
         would only end at the same broken-image icon after megabytes of
         traffic. Measured on the real box: 25 damaged PNGs, 2.5 s and up to
         2.4 MB each, all for nothing. */
      if (kind === 'image' && BROWSER_ONLY.test(rel)) {
        img.onerror = function () { noCover(); settle(); };
        img.src = rawUrl(rel);
        return;
      }
      noCover();
      settle();
    };
    img.src = thumbUrl(rel);
  } else {
    settle();
  }
}

function paintThumbs() {
  var bar = $('progbar'), more = $('more');
  if (bar) {
    if (!thumbsTotal) { bar.classList.add('hidden'); }
    else {
      bar.classList.remove('hidden');
      /* thumbsDone can never exceed thumbsTotal now (see trackThumbRow), so 100%
         is genuinely reachable and the bar cannot read 107%. The trailing "+"
         says the folder still has pages to come, so the total will keep growing. */
      var pct = Math.max(0, Math.min(100, Math.round(thumbsDone / thumbsTotal * 100)));
      $('progbarIn').style.width = pct + '%';
      $('progbarTxt').textContent = '已加載 ' + thumbsDone + ' / ' + thumbsTotal +
        (listHasMore ? '+' : '') + '　' + pct + '%' +
        (thumbRunning ? '　（同時 ' + thumbRunning + ' 個）' : '');
    }
  }
  /* This one line under the list is written here and nowhere else, so a page
     load in flight can never be reported by two writers fighting each other. */
  if (more) {
    if (!thumbsTotal) { more.classList.add('hidden'); more.textContent = ''; }
    else if (listBusy) { more.classList.remove('hidden'); more.textContent = '載入中…'; }
    else if (listHasMore) { more.classList.remove('hidden'); more.textContent = '下面還有，會自動繼續載入'; }
    else { more.classList.add('hidden'); more.textContent = ''; }
  }
}

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
  /* FIRST thing after a refresh or after the password is accepted: read the
     shared settings off the NAS box, so this device comes up identical to every
     other one. A failure here must not lock anybody out - the cached values are
     still perfectly usable - so the error is swallowed and the listing proceeds.
     (A 401 is different: req() has already logged out and shown the login form.) */
  return loadSettings()
    .catch(function () { })
    .then(function () { return load(''); });
}

/* ----------------------------------------------------------------- listing
 * A folder can hold thousands of phone photos. Paging keeps the first paint
 * cheap; the serial thumbnail queue keeps bandwidth to exactly one request at
 * a time. Both are needed: paging alone still fires a burst of image requests. */

var PAGE = 200;
var listOffset = 0;
var listHasMore = false;
var listBusy = false;

function load(p) {
  listOffset = 0;
  listHasMore = false;
  listBusy = true;
  moreFails = 0;                     /* a brand new folder gets a clean slate */
  resetThumbs();
  showSkeleton();
  return req('GET', '/api/list?path=' + encodeURIComponent(p) + '&limit=' + PAGE + '&offset=0')
    .then(function (d) {
      cwd = d.path || '';
      listHasMore = !!d.hasMore;
      listOffset = (d.files || []).length;
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
    .finally(function () {
      hideSkeleton();
      listBusy = false;
      checkDisk();
      paintThumbs();
      /* The list may be taller than the window on a wide screen, in which case
         the whole folder is already in the DOM and the sweep should just run. */
      driveThumbs();
    });
}

function loadMore() {
  if (listBusy || !listHasMore) return;
  listBusy = true;
  paintThumbs();                     /* the single writer turns this into 載入中… */
  req('GET', '/api/list?path=' + encodeURIComponent(cwd) + '&limit=' + PAGE + '&offset=' + listOffset)
    .then(function (d) {
      moreFails = 0;
      listHasMore = !!d.hasMore;
      listOffset += (d.files || []).length;
      appendFiles(d.files || []);
    })
    .catch(function (e) {
      /* Two failures in a row and the automatic sweep stands down, so a broken
         request is not retried once per completed thumbnail. Scrolling to the
         bottom on purpose still triggers a fresh attempt. */
      moreFails++;
      toast(e.message, true);
    })
    .finally(function () { listBusy = false; paintThumbs(); driveThumbs(); });
}

/* Pull the next page a screen early so the user never lands on an empty bottom. */
var scrollArmed = false;
window.addEventListener('scroll', function () {
  if (scrollArmed || !listHasMore) return;
  scrollArmed = true;
  requestAnimationFrame(function () {
    scrollArmed = false;
    if (window.innerHeight + window.pageYOffset >= document.body.offsetHeight - 600) {
      moreFails = 0;                 /* a deliberate scroll forgives earlier failures */
      loadMore();
    }
  });
}, { passive: true });

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
  var dirs = d.dirs || [], files = d.files || [];
  if (!dirs.length && !files.length) {
    var e = document.createElement('li');
    e.className = 'empty';
    e.textContent = '（空文件夾）';
    ul.appendChild(e);
    thumbsTotal = 0;
    paintThumbs();
    return;
  }

  /* thumbsTotal is owned by trackThumbRow() alone - one increment per row
     created, nothing else. The old engine also seeded it with the folder's total
     file count and then incremented it again inside the queue, so the denominator
     was inflated and 100% was unreachable. */
  thumbsTotal = 0;
  thumbsDone = 0;

  dirs.forEach(function (it, idx) {
    var li = buildRow(it, idx);
    li.dataset.done = '1';                 /* a folder has no thumbnail to fetch */
    ul.appendChild(li);
    thumbsDone++;
  });

  files.forEach(function (it, idx) {
    var li = buildRow(it, idx);
    ul.appendChild(li);
    if (!li.dataset.thumb) { li.dataset.done = '1'; thumbsDone++; }   /* Word/PDF use an icon */
  });

  watchThumbs();
  paintThumbs();
}

/* Append the next page without disturbing what is already on screen. */
function appendFiles(files) {
  var ul = $('list');
  (files || []).forEach(function (it, idx) {
    var li = buildRow(it, idx);
    ul.appendChild(li);
    if (!li.dataset.thumb) { li.dataset.done = '1'; thumbsDone++; }
  });
  watchThumbs();
  paintThumbs();
}

function buildRow(it, idx) {
  {
    var rel = cwd ? cwd + '/' + it.name : it.name;
    var kind = it.dir ? 'dir' : kindOf(it.name);
    var li = document.createElement('li');
    li.className = 'tappable';
    li.style.setProperty('--i', String(Math.min(idx, 26)));

    var ic = document.createElement('span');
    ic.className = 'ico' + (KIND_CLASS[kind] ? ' ' + KIND_CLASS[kind] : '');
    ic.innerHTML = fileIcon(kind);
    li.appendChild(ic);

    /* Only images and video get a real thumbnail, and only when they scroll
       into view. The row is tagged, not preloaded - the serial queue picks it up. */
    if (kind === 'image' || kind === 'video') {
      li.dataset.kind = kind;
      li.dataset.thumb = rel;
    }

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

    /* Registered here rather than in the callers, so that no future code path can
       create a row without the sweep knowing about it. Document order == the
       order rows are created, which is the order the sweep must follow. */
    trackThumbRow(li);

    return li;
  }
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

/* ------------------------------------------------------- version & settings */

var APP = { version: null };

/* version.json is fetched with a cache-buster, then compared against the
   version this tab last saw. A mismatch means the user is looking at a cached
   build - which is exactly the state that makes "I fixed it but nothing
   changed" happen. */
function loadVersion() {
  return fetch('version.json?_=' + Date.now())
    .then(function (r) { return r.json(); })
    .then(function (v) {
      APP.version = v;
      $('verBtn').textContent = 'v' + v.version;
      var seen = localStorage.getItem('wb_nas_seen_version');
      if (seen && seen !== v.version) {
        $('upver').textContent = 'v' + v.version;
        $('upbar').classList.remove('hidden');
      }
      localStorage.setItem('wb_nas_seen_version', v.version);
    })
    .catch(function () { });
}

function openSheet(title, html) {
  $('sheetTitle').textContent = title;
  $('sheetBody').innerHTML = html;
  $('sheet').classList.add('on');
}

function closeSheet() {
  $('sheet').classList.remove('on');
  $('sheetBody').innerHTML = '';
}

$('sheetClose').onclick = closeSheet;
$('sheet').onclick = function (e) { if (e.target === this) closeSheet(); };
$('upRefresh').onclick = function () { location.reload(true); };

/* ============================== SETTINGS ==================================

   THE SETTINGS ARE STORED ON THE NAS BOX, NOT IN THIS BROWSER.

   The requirement, in the user's words: every setting must live on that machine,
   so that no matter which device opens the site - or whether it was refreshed or
   just logged in - the FIRST thing that happens is reading those values, and the
   settings screen on every device looks exactly the same.

   Why localStorage alone is not enough: it is per-browser and per-device. A new
   phone would start from scratch, and two devices would quietly disagree with
   each other forever.

   So the model is:
     - the JSON file on the NAS box is the single source of truth
     - localStorage is ONLY a first-paint cache, so the list is drawn with the
       right thumbnail size instead of flashing the default and then resizing
     - GET /api/settings is the first request after a refresh and the first
       request after a password is accepted
     - any change is POSTed, so the next device to load sees it immediately
   ========================================================================= */

/* Mirrors SETTINGS_SPEC in nas-server/server.js. Kept here so the UI can render
   correctly even on the very first paint, before the server has answered. */
var DEFAULTS = { thumbW: 170, thumbParallel: 3, autoPreload: true };
var SETTINGS = { thumbW: DEFAULTS.thumbW, thumbParallel: DEFAULTS.thumbParallel, autoPreload: DEFAULTS.autoPreload };
var SETTINGS_CACHE_KEY = 'wb_nas_settings';

/* One row per setting. Adding a setting in a future version = one line here plus
   one line in the server's SETTINGS_SPEC. */
var SETTING_ROWS = [
  {
    group: '顯示',
    key: 'thumbW',
    label: '縮略圖清晰度',
    hint: '清單裡每一格圖片的畫質',
    reload: true,                       /* thumbnails must be re-fetched */
    choices: [
      { v: 110, text: '最省流量 5KB', hint: '約 5 KB 一張，最快' },
      { v: 170, text: '標準 10KB', hint: '約 10 KB 一張（預設）' },
      { v: 260, text: '清晰 20KB', hint: '約 20 KB 一張' },
      { v: 400, text: '最清晰 45KB', hint: '約 45 KB 一張，最慢' },
    ],
  },
  {
    group: '進階',
    key: 'thumbParallel',
    label: '同時下載縮圖',
    hint: '一次同時抓幾個封面',
    choices: [
      { v: 1, text: '1 張', hint: '最省頻寬，最慢' },
      { v: 2, text: '2 張', hint: '慢' },
      { v: 3, text: '3 張', hint: '預設' },
      { v: 4, text: '4 張', hint: '快' },
      { v: 6, text: '6 張', hint: '最快，最吃頻寬' },
    ],
  },
  {
    group: '進階',
    key: 'autoPreload',
    label: '背景自動下載',
    hint: '看完一張就自己接著下一張',
    choices: [
      { v: true, text: '開啟', hint: '不用等你捲下去才開始（預設）' },
      { v: false, text: '關閉', hint: '只下載你看到的部分，省流量' },
    ],
  },
];

function rowByKey(k) {
  for (var i = 0; i < SETTING_ROWS.length; i++) if (SETTING_ROWS[i].key === k) return SETTING_ROWS[i];
  return null;
}

function choiceText(row, v) {
  for (var i = 0; i < row.choices.length; i++) if (String(row.choices[i].v) === String(v)) return row.choices[i].text;
  return String(v);
}

/* Anything that is not one of the allowed values (hand-edited cache, a value
   from a newer version that this build does not know) snaps back to the default
   rather than being rendered as an empty row. */
function sanitizeSettings() {
  SETTING_ROWS.forEach(function (r) {
    var ok = false;
    for (var i = 0; i < r.choices.length; i++) if (String(r.choices[i].v) === String(SETTINGS[r.key])) ok = true;
    if (!ok) SETTINGS[r.key] = DEFAULTS[r.key];
  });
}

function cacheSettings() {
  try { localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(SETTINGS)); } catch (e) { }
}

/* Instant, offline-safe restoration of the last known values. Runs before the
   first network call so the very first list is drawn at the right quality. */
function readCachedSettings() {
  var raw = null;
  try { raw = JSON.parse(localStorage.getItem(SETTINGS_CACHE_KEY) || 'null'); } catch (e) { raw = null; }
  if (raw && typeof raw === 'object') {
    for (var k in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, k) && Object.prototype.hasOwnProperty.call(raw, k)) SETTINGS[k] = raw[k];
    }
  } else {
    /* Pre-0.2.0 kept a single key of its own. Promote it, so upgrading does not
       silently reset the choice this browser had already made. */
    var legacy = parseInt(localStorage.getItem('wb_nas_thumb_w'), 10);
    if (legacy) SETTINGS.thumbW = legacy;
  }
  sanitizeSettings();
}

function absorbSettings(d) {
  if (d && d.settings) {
    for (var k in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, k) &&
          Object.prototype.hasOwnProperty.call(d.settings, k)) SETTINGS[k] = d.settings[k];
    }
  }
  sanitizeSettings();
  cacheSettings();
}

/* Single place where a setting turns into behaviour. All three settings are read
   live (thumbEdge / thumbParallel / autoPreload), so there is nothing to push
   into the DOM - but the sweep has to be told to re-plan. Without this, changing
   "同時下載縮圖" or "背景自動下載" would only take effect after leaving and
   re-entering the folder, which looks exactly like the setting did not save. */
function applySettings() {
  driveThumbs();
}

/* Read the shared settings from the NAS box. Called as the FIRST request after
   a refresh AND after a password is accepted. */
function loadSettings() {
  /* Snapshot what THIS device believed before the server answers. It is needed
     for the one-time migration below, and it must be taken first: absorbSettings()
     overwrites every known key with the server's value, so by the time the
     migration check runs the local choice would already be gone. */
  var local = {};
  for (var k in DEFAULTS) local[k] = SETTINGS[k];

  return req('GET', '/api/settings').then(function (d) {
    absorbSettings(d);
    applySettings();

    /* Very first run of this feature: the file does not exist on the NAS box
       yet, so whatever this browser had already chosen is promoted to become the
       shared value for every device - instead of being silently thrown away by
       the upgrade. This window is open only until somebody writes a real value,
       after which `stored` is true everywhere and nobody overwrites anybody. */
    if (d && d.stored === false) {
      var patch = {};
      for (var k2 in DEFAULTS) if (local[k2] !== DEFAULTS[k2]) patch[k2] = local[k2];
      if (Object.keys(patch).length) {
        for (var k3 in patch) SETTINGS[k3] = patch[k3];     /* apply at once */
        cacheSettings();
        return req('POST', '/api/settings', { settings: patch })
          .then(function (d2) { absorbSettings(d2); applySettings(); })
          .catch(function () { });
      }
    }
    return SETTINGS;
  });
}

function saveSettings(patch) {
  return req('POST', '/api/settings', { settings: patch }).then(function (d) {
    absorbSettings(d);
    applySettings();
    return d;
  });
}

/* Named resetAllSettings, not resetSettings: the button it is wired to carries
   id="resetSettings", and an element id becomes a global name on window. Keeping
   the two names apart means nobody has to reason about which one wins. */
function resetAllSettings() {
  return req('POST', '/api/settings/reset').then(function (d) {
    absorbSettings(d);
    applySettings();
    return d;
  });
}

/* --------------------------------------------------- the settings screen ---

   Layout follows the Android settings app, which is what the user asked for:
   the row shows ONLY the value that is currently selected plus a down arrow.
   Tapping it unfolds the list of choices. Only ONE list can be open at a time -
   opening another collapses the previous one automatically. */

function closeMenus(except) {
  var open = $('sheetBody').querySelectorAll('.wx-sel.open');
  for (var i = 0; i < open.length; i++) if (open[i] !== except) open[i].classList.remove('open');
}

/* Registered ONCE on the sheet, not per render: the element survives the
   innerHTML swap, so wiring this inside showSettings() would stack up one
   duplicate listener per open. Attached to #sheet rather than #sheetBody so
   that tapping the header or the padding folds the menu away too - which is
   what every Android settings screen does. Taps that land inside a .wx-sel are
   left to that row's own handler. */
$('sheet').addEventListener('click', function (e) {
  var n = e.target;
  while (n && n !== this) { if (n.classList && n.classList.contains('wx-sel')) return; n = n.parentNode; }
  closeMenus(null);
});

function paintRow(sel, row) {
  var val = sel.querySelector('.val');
  if (val) val.textContent = choiceText(row, SETTINGS[row.key]);
  var opts = sel.querySelectorAll('.wx-opt');
  for (var i = 0; i < opts.length; i++) {
    var on = String(opts[i].dataset.v) === String(SETTINGS[row.key]);
    if (on) opts[i].setAttribute('data-on', '1'); else opts[i].removeAttribute('data-on');
    opts[i].querySelector('.mark').innerHTML = on ? '&#10003;' : '';
  }
}

function showSettings() {
  var groups = [], order = [];
  SETTING_ROWS.forEach(function (r) {
    if (order.indexOf(r.group) < 0) { order.push(r.group); groups.push({ name: r.group, rows: [] }); }
    groups[order.indexOf(r.group)].rows.push(r);
  });

  var h = '';
  groups.forEach(function (g) {
    h += '<div class="wx-group"><div class="gt">' + g.name + '</div>';
    g.rows.forEach(function (r) {
      h += '<div class="wx-sel" data-key="' + r.key + '">' +
             '<div class="wx-srow" role="button" tabindex="0" aria-expanded="false">' +
               '<span class="lbl"><b>' + r.label + '</b><small>' + r.hint + '</small></span>' +
               '<span class="val">' + choiceText(r, SETTINGS[r.key]) + '</span>' +
               '<span class="arw" aria-hidden="true"></span>' +
             '</div><div class="wx-menu" style="--mh:' + (r.choices.length * 64 + 8) + 'px">';
      r.choices.forEach(function (c) {
        var on = String(c.v) === String(SETTINGS[r.key]);
        h += '<div class="wx-opt"' + (on ? ' data-on="1"' : '') + ' data-v="' + c.v + '">' +
             '<span class="mark">' + (on ? '&#10003;' : '') + '</span>' +
             '<span class="lbl"><b>' + c.text + '</b>' + (c.hint ? '<small>' + c.hint + '</small>' : '') + '</span>' +
             '</div>';
      });
      h += '</div></div>';
    });
    h += '</div>';
  });

  h += '<div class="wx-group"><div class="gt">維護</div>' +
       '<div class="wx-opt" id="clearThumbs"><span class="mark"></span>' +
       '<span class="lbl"><b>清除縮略圖快取</b><small>下次查看會重新產生</small></span></div>' +
       '<div class="wx-opt danger" id="resetSettings"><span class="mark"></span>' +
       '<span class="lbl"><b>恢復默認設置</b><small>所有設定回到出廠值</small></span></div>' +
       '</div>';

  h += '<div class="wx-note">這些設定<b>存在 NAS 那台機</b>，不在這部裝置。<br>' +
       '無論用手機、平板還是電腦，登入之後看到的都一模一樣；' +
       '在這裡改，其他裝置下次進入就是新的值。</div>';

  openSheet('設置', h);
  wireSettings();
}

function wireSettings() {
  var body = $('sheetBody');

  Array.prototype.forEach.call(body.querySelectorAll('.wx-sel'), function (sel) {
    var row = rowByKey(sel.dataset.key);
    if (!row) return;
    var head = sel.querySelector('.wx-srow');

    head.onclick = function () {
      var willOpen = !sel.classList.contains('open');
      closeMenus(sel);                       /* exactly one menu open, always */
      sel.classList.toggle('open', willOpen);
      head.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    };
    head.onkeydown = function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); head.onclick(); }
    };

    Array.prototype.forEach.call(sel.querySelectorAll('.wx-opt'), function (opt) {
      opt.onclick = function () {
        var raw = opt.dataset.v;
        var v = (raw === 'true') ? true : (raw === 'false') ? false : parseInt(raw, 10);
        if (String(v) === String(SETTINGS[row.key])) { closeMenus(null); return; }
        head.classList.add('busy');
        var patch = {};
        patch[row.key] = v;
        saveSettings(patch)
          .then(function () {
            paintRow(sel, row);
            closeMenus(null);
            toast('已設定為「' + choiceText(row, SETTINGS[row.key]) + '」');
            if (row.reload) load(cwd);          /* new size = new images to fetch */
          })
          .catch(function (e) { toast(e.message, true); })
          .finally(function () { head.classList.remove('busy'); });
      };
    });
  });

  /* Tapping any empty part of the panel folds the open menu away - handled by
     the one delegated listener registered next to closeMenus(). */

  var ct = $('clearThumbs');
  if (ct) ct.onclick = function () {
    if (ct.classList.contains('busy')) return;
    ct.classList.add('busy');
    req('POST', '/api/thumb/clear')
      .then(function (d) { toast('已清除 ' + d.removed + ' 張縮圖快取'); })
      .catch(function (e) { toast(e.message, true); })
      .finally(function () { ct.classList.remove('busy'); });
  };

  var rs = $('resetSettings');
  if (rs) rs.onclick = function () {
    if (rs.classList.contains('busy')) return;
    if (!confirm('恢復默認設置？\n\n縮略圖清晰度、同時下載縮圖、背景自動下載\n全部回到出廠值。\n（所有裝置都會一起變回出廠值）')) return;
    rs.classList.add('busy');
    resetAllSettings()
      .then(function () { toast('已恢復默認設置'); closeSheet(); load(cwd); })
      .catch(function (e) { toast(e.message, true); })
      .finally(function () { rs.classList.remove('busy'); });
  };
}

function showLog() {
  var v = APP.version;
  if (!v) { openSheet('版本與更新日誌', '<div class="wx-empty">讀取不到版本檔</div>'); return; }
  var h = '<div class="wx-log"><div class="wx-note">' +
          '目前版本 <code>v' + v.version + '</code>　' + v.codename + '　建於 ' + v.builtAt + '</div>';
  (v.changes || []).forEach(function (c) {
    h += '<div class="vline"><b>v' + c.v + '</b><span>' + c.date + '</span></div><ul>';
    (c.items || []).forEach(function (t) { h += '<li>' + t + '</li>'; });
    h += '</ul>';
  });
  openSheet('版本與更新日誌', h + '</div>');
}

$('gearBtn').onclick = showSettings;
$('verBtn').onclick = showLog;

/* --------------------------------------------------------------------- boot */

/* The cache is applied synchronously so the first paint already uses the right
   thumbnail size; the authoritative copy is then read from the NAS box before
   the first folder listing. */
readCachedSettings();
loadVersion();

if (token) {
  start();
} else {
  $('login').classList.remove('hidden');
}
