/* Where the backend lives.
 *
 * The same pages are served from two places:
 *   1. GitHub Pages  -> https://oscar114515.github.io/nas/     (needs the ts.net API)
 *   2. the NAS itself -> http://127.0.0.1:8080/               (same origin, empty API)
 */
(function () {
  var h = location.hostname;
  var sameOrigin = (h === '127.0.0.1' || h === 'localhost' || h === '' || h.endsWith('.ts.net'));
  window.WB = {
    API: sameOrigin ? '' : 'https://oscar-nas.taila1f9c2.ts.net',
    LOC: { lat: 22.2842, lon: 114.2180, name: '香港東區' }
  };
})();
