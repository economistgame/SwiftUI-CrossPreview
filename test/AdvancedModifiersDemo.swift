import SwiftUI

struct AdvancedModifiersDemo: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("Advanced Modifiers")
                    .font(.largeTitle)
                    .bold()
                
                // Position Modifier
                VStack(alignment: .leading, spacing: 12) {
                    Text("Position Modifier")
                        .font(.title)
                        .bold()
                    
                    Text("Absolute positioning with x and y coordinates")
                        .font(.subheadline)
                        .foregroundColor(.gray)
                    
                    ZStack {
                        Rectangle()
                            .fill(.ultraThinMaterial)
                            .frame(width: 300, height: 100)
                            .cornerRadius(15)
                        
                        Circle()
                            .fill(.red)
                            .frame(width: 10, height: 10)
                            .position(x: 50, y: 50)
                        
                        Circle()
                            .fill(.blue)
                            .frame(width: 60, height: 60)
                            .position(x: 50, y: 40)
                        
                        Circle()
                            .fill(.red)
                            .frame(width: 50, height: 50)
                            .position(x: 150, y: 150)
                    }
                    .padding()
                    .background(.white)
                    .cornerRadius(12)
                }
                .padding()
                .background(.thinMaterial)
                .cornerRadius(16)
                
                Divider()
                
                // AspectRatio Modifiers
                VStack(alignment: .leading, spacing: 12) {
                    Text("Aspect Ratio & Scaling")
                        .font(.title)
                        .bold()
                    
                    Text("Control how images and views scale")
                        .font(.subheadline)
                        .foregroundColor(.gray)
                    
                    VStack(spacing: 12) {
                        VStack(alignment: .leading) {
                            Text(".scaledToFit()")
                                .font(.caption)
                                .foregroundColor(.gray)
                            Rectangle()
                                .fill(.blue)
                                .frame(width: 200, height: 100)
                                .scaledToFit()
                        }
                        .padding()
                        .background(.white)
                        .cornerRadius(8)
                        
                        VStack(alignment: .leading) {
                            Text(".scaledToFill()")
                                .font(.caption)
                                .foregroundColor(.gray)
                            Rectangle()
                                .fill(.purple)
                                .frame(width: 200, height: 100)
                                .scaledToFill()
                                .clipped()
                        }
                        .padding()
                        .background(.white)
                        .cornerRadius(8)
                        
                        VStack(alignment: .leading) {
                            Text(".aspectRatio(16/9, contentMode: .fit)")
                                .font(.caption)
                                .foregroundColor(.gray)
                            Rectangle()
                                .fill(.green)
                                .aspectRatio(1.777, contentMode: .fit)
                                .frame(width: 280)
                        }
                        .padding()
                        .background(.white)
                        .cornerRadius(8)
                    }
                }
                .padding()
                .background(.regularMaterial)
                .cornerRadius(16)
                
                Divider()
                
                // ClipShape Modifier
                VStack(alignment: .leading, spacing: 12) {
                    Text("Clip Shape")
                        .font(.title)
                        .bold()
                    
                    Text("Clip content to specific shapes")
                        .font(.subheadline)
                        .foregroundColor(.gray)
                    
                    HStack(spacing: 16) {
                        VStack {
                            Rectangle()
                                .fill(.red)
                                .frame(width: 80, height: 80)
                                .clipShape(Circle())
                            Text("Circle")
                                .font(.caption)
                        }
                        
                        VStack {
                            Rectangle()
                                .fill(.blue)
                                .frame(width: 80, height: 80)
                                .clipShape(Capsule())
                            Text("Capsule")
                                .font(.caption)
                        }
                        
                        VStack {
                            Rectangle()
                                .fill(.green)
                                .frame(width: 80, height: 80)
                                .clipShape(RoundedRectangle(cornerRadius: 20))
                            Text("Rounded")
                                .font(.caption)
                        }
                    }
                    .padding()
                    .background(.white)
                    .cornerRadius(12)
                }
                .padding()
                .background(.ultraThinMaterial)
                .cornerRadius(16)
                
                Divider()
                
                // Interaction Modifiers
                VStack(alignment: .leading, spacing: 12) {
                    Text("Interaction Modifiers")
                        .font(.title)
                        .bold()
                    
                    Text("Gesture and interaction controls")
                        .font(.subheadline)
                        .foregroundColor(.gray)
                    
                    VStack(spacing: 12) {
                        Text("Tap Gesture")
                            .padding()
                            .frame(maxWidth: .infinity)
                            .background(.blue)
                            .foregroundColor(.white)
                            .cornerRadius(8)
                            .onTapGesture()
                        
                        Text("Long Press Gesture")
                            .padding()
                            .frame(maxWidth: .infinity)
                            .background(.purple)
                            .foregroundColor(.white)
                            .cornerRadius(8)
                            .onLongPressGesture()
                        
                        Text("Disabled Button")
                            .padding()
                            .frame(maxWidth: .infinity)
                            .background(.gray)
                            .foregroundColor(.white)
                            .cornerRadius(8)
                            .disabled(true)
                    }
                    .padding()
                    .background(.white)
                    .cornerRadius(12)
                }
                .padding()
                .background(.thinMaterial)
                .cornerRadius(16)
                
                // ForegroundStyle & Tint
                VStack(alignment: .leading, spacing: 12) {
                    Text("Modern Color APIs")
                        .font(.title)
                        .bold()
                    
                    Text("ForegroundStyle and Tint modifiers")
                        .font(.subheadline)
                        .foregroundColor(.gray)
                    
                    VStack(spacing: 12) {
                        Text("Using .foregroundStyle()")
                            .foregroundStyle(.blue)
                            .padding()
                            .background(.white)
                            .cornerRadius(8)
                        
                        Button("Tinted Button") {
                            // action
                        }
                        .tint(.green)
                        .padding()
                        .background(.white)
                        .cornerRadius(8)
                    }
                }
                .padding()
                .background(.regularMaterial)
                .cornerRadius(16)
                
                // Mask Example
                VStack(alignment: .leading, spacing: 12) {
                    Text("Mask Modifier")
                        .font(.title)
                        .bold()
                    
                    Text("Apply masking to views")
                        .font(.subheadline)
                        .foregroundColor(.gray)
                    
                    HStack(spacing: 16) {
                        LinearGradient(colors: [.red, .orange, .yellow], startPoint: .leading, endPoint: .trailing)
                            .frame(width: 100, height: 100)
                            .mask(Circle())
                        
                        LinearGradient(colors: [.blue, .cyan, .green], startPoint: .top, endPoint: .bottom)
                            .frame(width: 100, height: 100)
                            .mask(RoundedRectangle(cornerRadius: 20))
                    }
                    .padding()
                    .background(.white)
                    .cornerRadius(12)
                }
                .padding()
                .background(.ultraThinMaterial)
                .cornerRadius(16)
                
                // Lifecycle Modifiers
                VStack(alignment: .leading, spacing: 12) {
                    Text("Lifecycle Modifiers")
                        .font(.title)
                        .bold()
                    
                    Text("OnAppear and OnDisappear (no visual effect)")
                        .font(.subheadline)
                        .foregroundColor(.gray)
                    
                    VStack {
                        Text("View with Lifecycle")
                            .padding()
                            .onAppear()
                            .onDisappear()
                        
                        Text("These modifiers trigger when view appears/disappears")
                            .font(.caption)
                            .foregroundColor(.gray)
                    }
                    .padding()
                    .background(.white)
                    .cornerRadius(12)
                }
                .padding()
                .background(.thinMaterial)
                .cornerRadius(16)
                
                // Tips
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("💡")
                            .font(.title)
                        Text("Tips")
                            .font(.headline)
                    }
                    
                    Text("• Use .position() for absolute positioning in ZStack")
                    Text("• Use .scaledToFit() to prevent image distortion")
                    Text("• Use .clipShape() for custom clipping boundaries")
                    Text("• Use .disabled() to prevent user interaction")
                }
                .font(.subheadline)
                .foregroundColor(.gray)
                .padding()
                .background(.blue.opacity(0.1))
                .cornerRadius(12)
            }
            .padding(24)
        }
    }
}
