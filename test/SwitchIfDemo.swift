import SwiftUI

enum EstadoRadio {
    case apagada, buscando, sonando
}

struct RadioView: View {
    @State private var estado: EstadoRadio = .sonando
    @State private var favorita = true

    var body: some View {
        switch estado {
        case .apagada:
            Text("Radio apagada")
                .font(.title)
        case .buscando:
            ProgressView()
        case .sonando:
            VStack(spacing: 12) {
                Text("Sonando: Radio Clásica")
                    .font(.headline)
                if favorita {
                    Image(systemName: "star.fill")
                    Text("En favoritos")
                } else {
                    Text("Añadir a favoritos")
                }
                Button("Parar") {
                    if favorita { print("stop") }
                }
            }
        default:
            Text("Estado desconocido \"if\" { switch }")
        }
    }
}
