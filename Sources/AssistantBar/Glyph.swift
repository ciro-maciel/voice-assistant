// The state glyph: the glyph carries the state, the word carries the meaning. No color, except
// the red lock for a microphone the app cannot use. The bars of "Escutando"
// and "Falando" are the real sound level, so they move: data, not decoration.
import SwiftUI

struct StateGlyph: View {
    let state: LoopState
    var level: Double = 0
    /// On the gray.9 strip: white ink on dark.
    var isInverted = false
    /// The strip's size, the same as the Speech to Text overlay: squares of 10, bars up to 16.
    var isCompact = false
    private var square: CGFloat { isCompact ? 10 : 14 }

    private var ink: Color { isInverted ? Zen.gray0 : Zen.gray9 }
    private var faint: Color { isInverted ? Zen.gray7 : Zen.gray3 }

    var body: some View {
        Group {
            switch state {
            case .waiting, .offline:
                Rectangle().strokeBorder(isInverted ? Zen.gray5 : Zen.gray4, lineWidth: 1.5).frame(width: square, height: square)
            case .listening:
                Rectangle().fill(ink).frame(width: square, height: square)
            case .drafting:
                // Taking notes: the waiting square with something inside.
                ZStack {
                    Rectangle().strokeBorder(ink, lineWidth: 1.5)
                    Rectangle().fill(ink).frame(width: square * 0.4, height: square * 0.4)
                }
                .frame(width: square, height: square)
            case .hearing, .speaking:
                Bars(level: level, color: ink, maxHeight: isCompact ? 12 : 14)
            case .thinking:
                Steps(ink: ink, faint: faint, size: isCompact ? 4 : 5)
            case .muted:
                Icon(name: "lock", size: isCompact ? 14 : 18, color: Zen.red7)
            }
        }
        .frame(width: isCompact ? 18 : 22, height: isCompact ? 18 : 22)
    }
}

/// Five bars following one level; each bar a little different, so the row reads as a voice.
private struct Bars: View {
    let level: Double
    let color: Color
    var maxHeight: CGFloat = 14
    private let shape: [Double] = [0.55, 0.85, 1, 0.75, 0.5]

    var body: some View {
        HStack(alignment: .center, spacing: 2) {
            ForEach(0..<5, id: \.self) { i in
                Rectangle().fill(color).frame(width: 3, height: 4 + maxHeight * min(1, level * 2.2) * shape[i])
            }
        }
    }
}

/// Three squares lit one at a time: the session is working.
private struct Steps: View {
    let ink: Color
    let faint: Color
    var size: CGFloat = 5

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1.0 / 3)) { context in
            let step = Int(context.date.timeIntervalSinceReferenceDate * 3) % 3
            HStack(spacing: 2) {
                ForEach(0..<3, id: \.self) { i in
                    Rectangle().fill(i == step ? ink : faint).frame(width: size, height: size)
                }
            }
        }
    }
}
