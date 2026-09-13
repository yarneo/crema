/**
 * Dev-only config for measuring the skin ON a real device.
 *
 * The reason this exists: `env(safe-area-inset-*)` is 0 in every desktop
 * browser and 0 inside an iframe, so neither `vite dev` on a Mac nor
 * `dev/ipad.html` can tell you what an actual iPad reports. This serves the
 * app normally and injects a probe that reports the live geometry back to the
 * terminal, so a layout claim about the tablet can be checked instead of
 * assumed.
 *
 *   npx vite --config dev/vite.probe.config.ts --host 0.0.0.0 --port 5180
 *
 * It is never part of a build: `npm run build` uses vite.config.ts.
 */

import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import base from '../vite.config.ts';

const probe = (): Plugin => ({
  name: 'crema-device-probe',
  apply: 'serve',

  transformIndexHtml() {
    return [
      {
        tag: 'script',
        injectTo: 'body',
        children: `
          (function () {
            // Measure the variable the stylesheet actually uses, not env()
            // directly: inside the desktop harness env() is 0 and the inset is
            // injected as --safe-<name>, so reading env() here would report a
            // safe line the layout is not using and quietly pass everything.
            var read = function (name) {
              var el = document.createElement('div');
              el.style.cssText = 'position:fixed;height:var(--safe-' + name + ',0px)';
              document.body.appendChild(el);
              var value = el.getBoundingClientRect().height;
              document.body.removeChild(el);
              return Math.round(value);
            };

            // ?sweep=1 walks every tab once and returns to Brew, so a device
            // check does not depend on someone standing there tapping.
            if (location.search.indexOf('sweep=1') >= 0) {
              var order = ['Brew', 'Shots', 'Beans', 'Profiles', 'Settings', 'Brew'];
              var step = 0;
              var walk = function () {
                if (step >= order.length) return;
                var name = order[step++];
                var all = document.querySelectorAll('.tab');
                for (var i = 0; i < all.length; i++) {
                  if (all[i].textContent.trim().indexOf(name) === 0) { all[i].click(); break; }
                }
                setTimeout(walk, 2600);
              };
              setTimeout(walk, 2500);
            }

            var last = '';
            setInterval(function () {
              var tabs = document.querySelector('.tabs');
              var dock = document.querySelector('.nav-dock');
              var open = document.querySelector('.tab.on');
              var utils = document.querySelector('.header-utilities');
              if (!tabs || !dock) return;

              var bottom = read('bottom');
              var t = tabs.getBoundingClientRect();
              var rows = {};
              if (utils) {
                for (var i = 0; i < utils.children.length; i++) {
                  rows[Math.round(utils.children[i].getBoundingClientRect().top)] = 1;
                }
              }

              // The other way to fail: the row clears the indicator, but page
              // content sits under the dock itself.
              var dockTop = dock.getBoundingClientRect().top;
              var lowest = 0;
              var content = document.querySelectorAll('.advice-strip, .brew-rail .act, .screen-heading, .shot-list, .setup-save, .list');
              for (var c = 0; c < content.length; c++) {
                var box = content[c].getBoundingClientRect();
                if (box.height > 0 && box.bottom > lowest) lowest = box.bottom;
              }

              var report = {
                tab: open ? open.textContent.trim() : '?',
                vw: window.innerWidth,
                vh: window.innerHeight,
                dpr: window.devicePixelRatio,
                safe: [read('top'), read('right'), bottom, read('left')].join('/'),
                tabsBottom: Math.round(t.bottom),
                safeLine: window.innerHeight - bottom,
                clearsIndicator: Math.round(t.bottom) <= window.innerHeight - bottom,
                headerRows: Object.keys(rows).length,
                contentBottom: Math.round(lowest),
                dockTop: Math.round(dockTop),
                scrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
                contentClearsDock:
                  document.documentElement.scrollHeight > window.innerHeight + 1 ||
                  Math.round(lowest) <= Math.round(dockTop),
                hScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
                demo: !!document.querySelector('.demo-banner')
              };

              var payload = JSON.stringify(report);
              if (payload === last) return;
              last = payload;
              new Image().src = '/__probe?d=' + encodeURIComponent(payload) + '&t=' + Date.now();
            }, 1200);
          })();
        `
      }
    ];
  },

  configureServer(server) {
    server.middlewares.use('/__probe', (req, res) => {
      const query = (req.url ?? '').split('d=')[1]?.split('&')[0] ?? '';
      try {
        console.log('[probe] ' + decodeURIComponent(query));
      } catch {
        console.log('[probe] <unparseable>');
      }
      res.statusCode = 204;
      res.end();
    });
  }
});

export default defineConfig({ ...base, plugins: [probe()] });
