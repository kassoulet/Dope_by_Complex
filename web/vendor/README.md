# vendor

`libopenmpt.js` is libopenmpt (the OpenMPT project's module player library, BSD licence) compiled to
WebAssembly with Emscripten, with the WASM embedded, as shipped in the npm package `chiptune3` 0.8.9
(`libopenmpt.worklet.js`, MIT for the wrapper code, the compiled libopenmpt under the OpenMPT BSD
licence).  The page uses it through `web/js/openmpt.js` to play `DOPE.MOD`.  Source and licences:
https://lib.openmpt.org/libopenmpt/ and https://github.com/DrSnuggles/chiptune.
