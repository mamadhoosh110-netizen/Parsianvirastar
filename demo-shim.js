/* Demo shim: fake Office + Word APIs over an embedded textarea so the
   taskpane can be tested in a plain browser without a Word host. */
(function () {
  'use strict';

  // build the "document" editor panel on the left
  var wrap = document.createElement('div');
  wrap.id = 'demoDoc';
  wrap.style.cssText = 'position:fixed;top:0;left:0;bottom:0;width:calc(100vw - 430px);background:#fff;' +
    'display:flex;flex-direction:column;direction:rtl;z-index:9999;box-shadow:2px 0 12px rgba(0,0,0,.15);';
  wrap.innerHTML =
    '<div style="background:#1a1a1a;color:#fff;padding:10px 16px;font-size:13px">📄 سند ورد (شبیه‌سازی‌شده) — متن را ویرایش و «ویراستاری متن» را بزنید</div>' +
    '<textarea id="demoText" style="flex:1;border:none;padding:18px 22px;font-size:17px;line-height:2;' +
    'font-family:Vazirmatn,Tahoma;resize:none;outline:none;direction:rtl"></textarea>';
  document.documentElement.appendChild(wrap);
  // shift the taskpane body to the right (RTL page)
  document.body.style.marginLeft = 'calc(100vw - 430px)';
  document.body.style.minWidth = '420px';

  var ta = document.getElementById('demoText');
  ta.value = 'این یک متن آزمایشی است ، برای تست پارسیان . منکتاب خواندم و او به مدرسه رفت.\n' +
             'او میگوید که نمیآید.\n' +
             'کتابها را خواندیم و گلهای زیبایی دیدیم.\n' +
             'این مت ن است و برا شما فرستادم!';

  window.Office = {
    onReady: function (cb) { setTimeout(cb, 30); }
  };

  window.Word = {
    run: function (cb) {
      var texts = ta.value.split('\n');
      var paras = texts.map(function (t) { return makePara(t, ''); });

      function makePara(t, tag) {
        return {
          text: t,
          _t: t,
          search: function (target) {
            var self = this;
            var count = 0, idx = 0;
            while ((idx = self._t.indexOf(target, idx)) !== -1) { count++; idx += 1; }
            return {
              items: Array.apply(null, Array(Math.max(count, 1))).map(function (_, k) {
                return {
                  insertText: function (v) {
                    // replace the k-th occurrence of target
                    var i = -1, from = 0;
                    for (var q = 0; q <= k; q++) {
                      i = self._t.indexOf(target, from);
                      if (i < 0) return;
                      from = i + 1;
                    }
                    if (i >= 0) self._t = self._t.slice(0, i) + v + self._t.slice(i + target.length);
                    self.text = self._t;
                  }
                };
              })
            };
          }
        };
      }

      var ctx = {
        document: {
          body: {
            paragraphs: {
              load: function () { return { items: paras }; },
              getItemAt: function (i) { return paras[i]; }
            }
          }
        },
        load: function () {},
        sync: function () {
          return new Promise(function (res) {
            setTimeout(function () {
              ta.value = paras.map(function (p) { return p._t; }).join('\n');
              res();
            }, 20);
          });
        }
      };
      return Promise.resolve(cb(ctx)).then(function () { return ctx.sync(); });
    }
  };
})();
