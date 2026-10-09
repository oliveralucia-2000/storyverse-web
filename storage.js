// StoryVerse web storage: IndexedDB for the database snapshot and photos.
// Photos are kept as JPEG blobs under "media://<id>" keys.
(function () {
  var DB_NAME = 'storyverse';
  var db = null;
  var urlCache = {};
  var persisted = false;

  function open(cb) {
    var req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = function () {
      var d = req.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('media')) d.createObjectStore('media');
    };
    req.onsuccess = function () { db = req.result; cb(true); };
    req.onerror = function () { cb(false); };
  }

  function tx(store, mode) { return db.transaction(store, mode).objectStore(store); }

  function newId() {
    return (crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2));
  }

  function bytesToBinary(u8) {
    var out = '';
    var CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return out;
  }
  function binaryToBytes(s) {
    var u8 = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 255;
    return u8;
  }

  function resolveBlob(uri, cb) {
    if (uri.indexOf('media://') === 0) {
      var r = tx('media', 'readonly').get(uri.substring(8));
      r.onsuccess = function () { cb(r.result || null); };
      r.onerror = function () { cb(null); };
    } else {
      fetch(uri).then(function (res) { return res.blob(); }).then(cb).catch(function () { cb(null); });
    }
  }

  function putMedia(blob, cb) {
    var id = newId();
    var r = tx('media', 'readwrite').put(blob, id);
    r.onsuccess = function () { cb('media://' + id); };
    r.onerror = function () { cb(''); };
  }

  // Decode a blob to a canvas no bigger than maxSide, honoring EXIF rotation.
  function downscale(blob, maxSide, cb) {
    var done = function (img, w, h) {
      var s = Math.min(1, maxSide / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
      var c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      c.getContext('2d').drawImage(img, 0, 0, cw, ch);
      c.toBlob(function (b) { cb(b); }, 'image/jpeg', 0.88);
    };
    if (window.createImageBitmap) {
      createImageBitmap(blob, { imageOrientation: 'from-image' }).then(function (bmp) { done(bmp, bmp.width, bmp.height); })
        .catch(function () { viaImg(); });
    } else viaImg();
    function viaImg() {
      var u = URL.createObjectURL(blob);
      var im = new Image();
      im.onload = function () { done(im, im.naturalWidth, im.naturalHeight); URL.revokeObjectURL(u); };
      im.onerror = function () { cb(null); };
      im.src = u;
    }
  }

  window.SV = {
    init: function (cb) {
      open(function (ok) {
        try {
          if (navigator.storage && navigator.storage.persist) {
            navigator.storage.persist().then(function (p) { persisted = !!p; }).catch(function () {});
          }
        } catch (e) {}
        cb(ok);
      });
    },
    isPersisted: function () { return persisted; },
    kvGet: function (key, cb) {
      if (!db) { cb(null); return; }
      var r = tx('kv', 'readonly').get(key);
      r.onsuccess = function () { cb(r.result == null ? null : String(r.result)); };
      r.onerror = function () { cb(null); };
    },
    kvPut: function (key, value) {
      if (!db) return;
      try { tx('kv', 'readwrite').put(value, key); } catch (e) {}
    },
    pickImages: function (multiple, cb) {
      var i = document.createElement('input');
      i.type = 'file'; i.accept = 'image/*';
      if (multiple) i.multiple = true;
      i.style.position = 'fixed'; i.style.left = '-1000px';
      document.body.appendChild(i);
      i.onchange = function () {
        var urls = [];
        for (var k = 0; k < i.files.length; k++) urls.push(URL.createObjectURL(i.files[k]));
        i.remove();
        cb(urls.join('\n'));
      };
      i.click();
    },
    // Copy any image (blob:, media://, http…) into storage, downscaled. cb(mediaUri or '').
    importImage: function (src, maxSide, cb) {
      resolveBlob(src, function (blob) {
        if (!blob) { cb(''); return; }
        downscale(blob, maxSide, function (b) { if (!b) { cb(''); return; } putMedia(b, cb); });
      });
    },
    // Raw bytes of an image as a binary string ('' if missing), downscaled to maxSide.
    loadBytes: function (src, maxSide, cb) {
      resolveBlob(src, function (blob) {
        if (!blob) { cb(''); return; }
        var finish = function (b) { b.arrayBuffer().then(function (ab) { cb(bytesToBinary(new Uint8Array(ab))); }).catch(function () { cb(''); }); };
        if (maxSide > 0) downscale(blob, maxSide, function (b) { if (b) finish(b); else cb(''); });
        else finish(blob);
      });
    },
    // Store bytes given as a binary string. cb(mediaUri).
    storeBytes: function (bin, mime, cb) {
      putMedia(new Blob([binaryToBytes(bin)], { type: mime || 'image/jpeg' }), cb);
    },
    // ---- Backups ----
    listMedia: function (cb) {
      var r = tx('media', 'readonly').getAllKeys();
      r.onsuccess = function () { cb((r.result || []).join('\n')); };
      r.onerror = function () { cb(''); };
    },
    mediaBase64: function (id, cb) {
      var r = tx('media', 'readonly').get(id);
      r.onsuccess = function () {
        if (!r.result) { cb(''); return; }
        var fr = new FileReader();
        fr.onload = function () { var s = String(fr.result); cb(s.substring(s.indexOf(',') + 1)); };
        fr.onerror = function () { cb(''); };
        fr.readAsDataURL(r.result);
      };
      r.onerror = function () { cb(''); };
    },
    putMediaBase64: function (id, b64, mime) {
      var bin = atob(b64);
      tx('media', 'readwrite').put(new Blob([binaryToBytes(bin)], { type: mime || 'image/jpeg' }), id);
    },
    downloadText: function (name, text) {
      var b = new Blob([text], { type: 'application/json' });
      var file = null;
      try { file = new File([b], name, { type: 'application/json' }); } catch (e) {}
      if (file && navigator.canShare && navigator.canShare({ files: [file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
        navigator.share({ files: [file], title: name }).catch(function () {});
        return;
      }
      var a = document.createElement('a');
      a.href = URL.createObjectURL(b); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
    },
    pickTextFile: function (cb) {
      var i = document.createElement('input');
      i.type = 'file'; i.accept = '.json,.storyverse,application/json';
      i.style.position = 'fixed'; i.style.left = '-1000px';
      document.body.appendChild(i);
      i.onchange = function () {
        var f = i.files[0]; i.remove();
        if (!f) return;
        f.text().then(cb).catch(function () {});
      };
      i.click();
    },
    // ---- Back button (browser / Android) ----
    installBack: function (cb) {
      try {
        history.pushState({ sv: 1 }, '');
        window.addEventListener('popstate', function () {
          cb();
          history.pushState({ sv: 1 }, '');
        });
        window.addEventListener('keydown', function (e) { if (e.key === 'Escape') cb(); });
      } catch (e) {}
    },
    // One shared <audio> per sound; iOS only lets it play later if it was started during a tap.
    audio: function (src) {
      window.__svAudio = window.__svAudio || {};
      if (!window.__svAudio[src]) { var a = new Audio(src); a.preload = 'auto'; window.__svAudio[src] = a; }
      return window.__svAudio[src];
    },
    playAudio: function (src, vol) {
      try { var a = SV.audio(src); a.volume = vol; a.currentTime = 0; var p = a.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
    },
    stopAudio: function (src) { try { SV.audio(src).pause(); } catch (e) {} },
    // Loader turns into "tap to enter"; the tap unlocks the intro sound.
    waitForTap: function (src, cb) {
      var l = document.getElementById('loader');
      if (!l) { cb(); return; }
      var s = l.querySelector('small');
      if (s) s.textContent = 'Tocá para entrar ✨';
      l.style.cursor = 'pointer';
      var go = function () {
        l.removeEventListener('click', go);
        try { var a = SV.audio(src); a.muted = true; var p = a.play(); var undo = function () { a.pause(); a.currentTime = 0; a.muted = false; };
          if (p && p.then) p.then(undo).catch(undo); else undo(); } catch (e) {}
        l.remove();
        cb();
      };
      l.addEventListener('click', go);
    },
    onHide: function (cb) {
      document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') cb(); });
      window.addEventListener('pagehide', function () { cb(); });
    }
  };
})();
