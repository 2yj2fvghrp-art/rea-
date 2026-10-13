import UIKit

@main
final class ReaDisplayFixture: UIResponder, UIApplicationDelegate {
  func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(name: "REA Fixture", sessionRole: session.role)
    configuration.delegateClass = ReaDisplayScene.self
    return configuration
  }
}

final class ReaDisplayScene: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
    guard let scene = scene as? UIWindowScene else { return }
    let controller = UIViewController()
    controller.view.backgroundColor = UIColor(red: 0.85, green: 0.05, blue: 0.72, alpha: 1)
    let label = UILabel()
    label.translatesAutoresizingMaskIntoConstraints = false
    label.text = "REA Simulator Display Fixture"
    label.textColor = .white
    label.textAlignment = .center
    label.font = UIFont.boldSystemFont(ofSize: 26)
    controller.view.addSubview(label)
    NSLayoutConstraint.activate([
      label.centerXAnchor.constraint(equalTo: controller.view.centerXAnchor),
      label.centerYAnchor.constraint(equalTo: controller.view.centerYAnchor),
      label.leadingAnchor.constraint(greaterThanOrEqualTo: controller.view.leadingAnchor, constant: 20),
      label.trailingAnchor.constraint(lessThanOrEqualTo: controller.view.trailingAnchor, constant: -20),
    ])
    let window = UIWindow(windowScene: scene)
    window.rootViewController = controller
    window.makeKeyAndVisible()
    self.window = window
  }
}
