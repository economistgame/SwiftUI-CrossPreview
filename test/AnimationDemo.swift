import SwiftUI

struct AnimationDemo: View {
    @State private var isRotated = true
    @State private var isScaled = true
    
    var body: some View {
        VStack(spacing: 30) {
            Text("Animation Indicators")
                .font(.title)
                .padding()
            
            // Rotation animation
            Text("Rotating Text")
                .font(.headline)
                .padding()
                .background(Color.blue)
                .foregroundColor(.white)
                .cornerRadius(8)
                .rotationEffect(.degrees(isRotated ? 155 : 0))
                .animation(.easeInOut(duration: 1))
            
            // Scale animation
            Circle()
                .fill(Color.green)
                .frame(width: 220, height: 220)
                .scaleEffect(isScaled ? 0.5 : 1.0)
                .animation(.spring())
            
            // Opacity animation
            Text("Fading Text")
                .opacity(isRotated ? 0.3 : 1.0)
                .animation(.linear(duration: 0.5))
            
            // Combined animations
            RoundedRectangle(cornerRadius: 12)
                .fill(
                    LinearGradient(
                        colors: [.purple, .pink],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .frame(width: 150, height: 150)
                .rotationEffect(.degrees(isScaled ? 10 : 80))
                .scaleEffect(isScaled ? 0.8 : 1.0)
                .animation(.easeInOut)
            
            Text("🎬 Animation Badge Shows Animated Views")
                .font(.caption)
                .foregroundColor(.gray)
                .padding()
        }
        .padding()
    }
}

struct AnimationDemo_Previews: PreviewProvider {
    static var previews: some View {
        AnimationDemo()
    }
}
