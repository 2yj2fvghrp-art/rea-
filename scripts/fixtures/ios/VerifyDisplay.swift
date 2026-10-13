import AppKit

guard CommandLine.arguments.count == 2,
      let data = try? Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])),
      let bitmap = NSBitmapImageRep(data: data),
      let sample = bitmap.colorAt(x: bitmap.pixelsWide / 8, y: bitmap.pixelsHigh / 4)?.usingColorSpace(NSColorSpace.deviceRGB)
else { fatalError("Could not decode captured PNG") }

guard sample.redComponent > 0.70,
      sample.greenComponent < 0.35,
      sample.blueComponent > 0.55
else { fatalError("Captured display does not show the source-owned fixture background") }

print("source-owned fixture pixels observed")
