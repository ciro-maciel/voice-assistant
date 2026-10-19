// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "AssistantBar",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "AssistantBar", path: "Sources/AssistantBar")
    ]
)
