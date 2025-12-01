import SwiftUI

struct AccessibilityDemo: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("Accessibility Modifiers")
                    .font(.largeTitle)
                    .bold()
                
                Text("Enhance accessibility for screen readers and assistive technologies")
                    .font(.subheadline)
                    .foregroundColor(.gray)
                
                Divider()
                
                // AccessibilityLabel
                VStack(alignment: .leading, spacing: 12) {
                    Text("Accessibility Label")
                        .font(.title)
                        .bold()
                    
                    Text("Provides alternative text for screen readers")
                        .font(.subheadline)
                        .foregroundColor(.gray)
                    
                    VStack(spacing: 12) {
                        Button("Test Button") {
                            // Like action
                        }
                        .font(.title)
                        .padding()
                        .background(.red)
                        .foregroundColor(.white)
                        .cornerRadius(12)
                        .accessibilityLabel("Like button")
                        
                        Text("Screen readers will announce: 'Like button' instead of 'heart emoji'")
                            .font(.caption)
                            .foregroundColor(.gray)
                            .padding(.horizontal)
                    }
                    .padding()
                    .background(.white)
                    .cornerRadius(12)
                    
                    VStack(spacing: 12) {
                        Image("user-avatar")
                            .padding()
                            .background(.blue)
                            .cornerRadius(50)
                            .accessibilityLabel("User profile picture")
                        
                        Text("Descriptive labels help users understand image content")
                            .font(.caption)
                            .foregroundColor(.gray)
                            .padding(.horizontal)
                    }
                    .padding()
                    .background(.white)
                    .cornerRadius(12)
                }
                .padding()
                .background(.thinMaterial)
                .cornerRadius(16)
                
                Divider()
                
                // AccessibilityHint
                VStack(alignment: .leading, spacing: 12) {
                    Text("Accessibility Hint")
                        .font(.title)
                        .bold()
                    
                    Text("Provides usage hints about what happens when interacting")
                        .font(.subheadline)
                        .foregroundColor(.gray)
                    
                    VStack(spacing: 12) {
                        Button("Next") {
                            // Navigation
                        }
                        .padding()
                        .frame(maxWidth: .infinity)
                        .background(.blue)
                        .foregroundColor(.white)
                        .cornerRadius(12)
                        .accessibilityLabel("Next button")
                        .accessibilityHint("Navigates to the next page")
                        
                        Text("Hint: 'Navigates to the next page'")
                            .font(.caption)
                            .foregroundColor(.gray)
                    }
                    .padding()
                    .background(.white)
                    .cornerRadius(12)
                    
                    VStack(spacing: 12) {
                        Toggle("Notifications", isOn: true)
                            .padding()
                            .accessibilityHint("Double tap to toggle notifications on or off")
                        
                        Text("Hint: 'Double tap to toggle notifications on or off'")
                            .font(.caption)
                            .foregroundColor(.gray)
                    }
                    .padding()
                    .background(.white)
                    .cornerRadius(12)
                }
                .padding()
                .background(.regularMaterial)
                .cornerRadius(16)
                
                Divider()
                
                // AccessibilityValue
                VStack(alignment: .leading, spacing: 12) {
                    Text("Accessibility Value")
                        .font(.title)
                        .bold()
                    
                    Text("Describes the current value of interactive controls")
                        .font(.subheadline)
                        .foregroundColor(.gray)
                    
                    VStack(spacing: 12) {
                        VStack(alignment: .leading) {
                            Text("Volume: 75%")
                                .font(.subheadline)
                            Slider(value: 75, in: 0...100)
                                .accessibilityLabel("Volume slider")
                                .accessibilityValue("75 percent")
                        }
                        
                        Text("Value: '75 percent' (announced when focused)")
                            .font(.caption)
                            .foregroundColor(.gray)
                    }
                    .padding()
                    .background(.white)
                    .cornerRadius(12)
                    
                    VStack(spacing: 12) {
                        VStack(alignment: .leading) {
                            Text("Rating: ⭐⭐⭐⭐☆")
                                .font(.title2)
                                .accessibilityLabel("Rating")
                                .accessibilityValue("4 out of 5 stars")
                        }
                        
                        Text("Value: '4 out of 5 stars'")
                            .font(.caption)
                            .foregroundColor(.gray)
                    }
                    .padding()
                    .background(.white)
                    .cornerRadius(12)
                }
                .padding()
                .background(.ultraThinMaterial)
                .cornerRadius(16)
                
                Divider()
                
                // Combined Example
                VStack(alignment: .leading, spacing: 12) {
                    Text("Complete Accessibility Example")
                        .font(.title)
                        .bold()
                    
                    Text("Using all three modifiers together")
                        .font(.subheadline)
                        .foregroundColor(.gray)
                    
                    VStack(spacing: 16) {
                        // Play button with full accessibility
                        Button("▶️") {
                            // Play action
                        }
                        .font(.largeTitle)
                        .padding()
                        .background(.green)
                        .foregroundColor(.white)
                        .cornerRadius(50)
                        .accessibilityLabel("Play button")
                        .accessibilityHint("Starts playing the audio")
                        .accessibilityValue("Ready to play")
                        
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Label: 'Play button'")
                            Text("Hint: 'Starts playing the audio'")
                            Text("Value: 'Ready to play'")
                        }
                        .font(.caption)
                        .foregroundColor(.gray)
                        
                        Divider()
                        
                        // Shopping cart with accessibility
                        HStack {
                            Text("🛒")
                                .font(.title)
                            Text("(3)")
                                .font(.caption)
                        }
                        .padding()
                        .background(.orange)
                        .foregroundColor(.white)
                        .cornerRadius(12)
                        .accessibilityLabel("Shopping cart")
                        .accessibilityHint("Opens your cart to review items")
                        .accessibilityValue("3 items in cart")
                        
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Label: 'Shopping cart'")
                            Text("Hint: 'Opens your cart to review items'")
                            Text("Value: '3 items in cart'")
                        }
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
                
                // Best Practices
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text("♿️")
                            .font(.title)
                        Text("Best Practices")
                            .font(.headline)
                    }
                    
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(alignment: .top) {
                            Text("1.")
                            Text("Use .accessibilityLabel() for images, icons, and emoji")
                        }
                        
                        HStack(alignment: .top) {
                            Text("2.")
                            Text("Add .accessibilityHint() to buttons and interactive elements")
                        }
                        
                        HStack(alignment: .top) {
                            Text("3.")
                            Text("Provide .accessibilityValue() for controls with changing states")
                        }
                        
                        HStack(alignment: .top) {
                            Text("4.")
                            Text("Keep labels concise but descriptive")
                        }
                        
                        HStack(alignment: .top) {
                            Text("5.")
                            Text("Test with VoiceOver (iOS) or TalkBack (Android)")
                        }
                    }
                }
                .font(.subheadline)
                .foregroundColor(.gray)
                .padding()
                .background(.blue.opacity(0.1))
                .cornerRadius(12)
                
                // Note
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("ℹ️")
                            .font(.title)
                        Text("Important Note")
                            .font(.headline)
                    }
                    
                    Text("These modifiers have no visual effect in the preview. They enhance the experience for users with assistive technologies. Always test accessibility features with actual screen readers.")
                        .font(.subheadline)
                        .foregroundColor(.gray)
                }
                .padding()
                .background(.green.opacity(0.1))
                .cornerRadius(12)
            }
            .padding(24)
        }
    }
}
