// Runs the ZXing-C++ (WebAssembly) decoder off the main thread so the camera view never stutters.
importScripts("vendor/zxing-reader.js");

const READER_OPTIONS = {
  formats: ["UPCA", "UPCE", "EAN13", "EAN8"],
  tryHarder: true,     // scan every row: slower, but finds angled / damaged codes
  tryRotate: true,     // codes held sideways or upside down
  tryInvert: false,    // retail codes are never light-on-dark
  tryDownscale: true,  // helps with large, close, slightly blurry codes
  maxNumberOfSymbols: 8,
};

ZXingWASM.prepareZXingModule({
  overrides: {
    locateFile: (path, prefix) =>
      path.endsWith(".wasm") ? new URL("vendor/zxing_reader.wasm", self.location).href : prefix + path,
  },
  fireImmediately: true,
}).then(
  () => postMessage({ type: "ready" }),
  (err) => postMessage({ type: "error", message: String(err) }),
);

onmessage = async ({ data }) => {
  const { buffer, width, height } = data;
  let codes = [];
  try {
    const options = { ...READER_OPTIONS, binarizer: data.binarizer };
    const results = await ZXingWASM.readBarcodes(new ImageData(new Uint8ClampedArray(buffer), width, height), options);
    codes = results.filter((r) => r.isValid).map((r) => ({ text: r.text, position: r.position }));
  } catch (err) {
    // A failed frame is just a frame with no codes.
  }
  postMessage({ type: "result", codes });
};
