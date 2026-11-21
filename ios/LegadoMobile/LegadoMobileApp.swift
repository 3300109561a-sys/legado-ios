import SwiftUI
import WebKit
import Foundation

// LegadoMobile — a native iPadOS shell that hosts the 阅读 reading UI.
//
// The bundled UI is served through a custom URL scheme ("legado://local/")
// instead of file://. That matters:
//   * a file:// page has an opaque origin, so its fetch() to http://<server>
//     is blocked by WebKit — the shelf would just stay empty;
//   * routing every request through one scheme handler gives the page a real
//     origin and lets us proxy the Legado WebService paths, so the shell needs
//     no CORS rules and no knowledge of the server address.

let legadoScheme = "legado"
let legadoHost = "local"

// MARK: - Shared settings

final class ServerSettings: ObservableObject {
    @Published var serverURL: String {
        didSet { UserDefaults.standard.set(serverURL, forKey: "serverURL") }
    }
    @Published var forceDark: Bool {
        didSet { UserDefaults.standard.set(forceDark, forKey: "forceDark") }
    }

    init() {
        let saved = UserDefaults.standard.string(forKey: "serverURL") ?? ""
        self.serverURL = saved
        self.forceDark = UserDefaults.standard.bool(forKey: "forceDark")
    }

    var hasServer: Bool {
        !serverURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

// MARK: - App

@main
struct LegadoMobileApp: App {
    @StateObject private var settings = ServerSettings()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(settings)
                .preferredColorScheme(settings.forceDark ? .dark : nil)
        }
    }
}

struct ContentView: View {
    @EnvironmentObject private var settings: ServerSettings
    @State private var showSetup = false

    var body: some View {
        ZStack(alignment: .topTrailing) {
            ShellWebView(serverURL: settings.serverURL)
                .ignoresSafeArea(edges: [.horizontal, .bottom])

            Button {
                showSetup = true
            } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 17, weight: .semibold))
                    .padding(10)
                    .background(.regularMaterial, in: Circle())
            }
            .accessibilityLabel("设置服务地址")
            .padding(.trailing, 14)
            .padding(.top, 8)

            if showSetup || !settings.hasServer {
                SetupSheet(showSetup: $showSetup, mustConfigure: !settings.hasServer)
                    .transition(.opacity)
                    .zIndex(2)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: showSetup)
    }
}

// MARK: - Scheme handler (bundled files + WebService proxy)

final class LegadoSchemeHandler: NSObject, WKURLSchemeHandler {
    /// Paths that belong to the Legado WebService and must be proxied.
    private static let proxyPrefixes = [
        "/api/", "/get", "/save", "/delete",
        "/cover", "/image", "/searchBook",
    ]

    private let lock = NSLock()
    private var running: [ObjectIdentifier: URLSessionDataTask] = [:]
    private var cancelled: Set<ObjectIdentifier> = []

    /// Reads the current server address on every request so changing it in
    /// settings takes effect without recreating the web view.
    private var serverBase: URL? {
        let raw = UserDefaults.standard.string(forKey: "serverURL") ?? ""
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let url = URL(string: trimmed), url.host != nil else { return nil }
        return url
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let requestURL = urlSchemeTask.request.url else {
            fail(urlSchemeTask, code: -1, message: "missing url")
            return
        }
        let path = requestURL.path.isEmpty ? "/index.html" : requestURL.path

        if Self.proxyPrefixes.contains(where: { path.hasPrefix($0) }) {
            proxy(urlSchemeTask, requestURL: requestURL)
        } else {
            serveBundled(urlSchemeTask, path: path)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        let key = ObjectIdentifier(urlSchemeTask)
        lock.lock()
        cancelled.insert(key)
        let task = running.removeValue(forKey: key)
        lock.unlock()
        task?.cancel()
    }

    // MARK: bundled files

    private static let mimeTypes: [String: String] = [
        "html": "text/html; charset=utf-8",
        "css": "text/css; charset=utf-8",
        "js": "text/javascript; charset=utf-8",
        "mjs": "text/javascript; charset=utf-8",
        "json": "application/json; charset=utf-8",
        "webmanifest": "application/manifest+json; charset=utf-8",
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "gif": "image/gif",
        "svg": "image/svg+xml",
        "ico": "image/x-icon",
        "woff": "font/woff",
        "woff2": "font/woff2",
        "ttf": "font/ttf",
    ]

    private func serveBundled(_ task: WKURLSchemeTask, path: String) {
        let relative = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let nsPath = relative as NSString
        let fileName = nsPath.lastPathComponent
        let ext = (fileName as NSString).pathExtension
        let base = (fileName as NSString).deletingPathExtension
        let dir = nsPath.deletingLastPathComponent

        // WebApp is added to the target as a *folder reference*, so its
        // directory structure survives inside the bundle.
        let subdirectory = dir.isEmpty ? "WebApp" : "WebApp/\(dir)"
        var fileURL = Bundle.main.url(forResource: base,
                                      withExtension: ext.isEmpty ? nil : ext,
                                      subdirectory: subdirectory)
        if fileURL == nil {
            fileURL = Bundle.main.url(forResource: base,
                                      withExtension: ext.isEmpty ? nil : ext,
                                      subdirectory: "WebApp")
        }
        // Unknown route inside the app shell -> hand back index.html so the
        // single-page UI keeps working on a deep link.
        if fileURL == nil {
            fileURL = Bundle.main.url(forResource: "index", withExtension: "html",
                                      subdirectory: "WebApp")
        }
        guard let url = fileURL, let data = try? Data(contentsOf: url) else {
            fail(task, code: 404, message: "not found: \(path)")
            return
        }

        let mime = Self.mimeTypes[ext.lowercased()] ?? "application/octet-stream"
        let response = URLResponse(url: task.request.url!,
                                   mimeType: mime,
                                   expectedContentLength: data.count,
                                   textEncodingName: "utf-8")
        guard self.claim(task) else { return }
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
        self.release(task)
    }

    // MARK: proxy

    private func proxy(_ task: WKURLSchemeTask, requestURL: URL) {
        guard let base = serverBase else {
            // No server configured yet: answer as JSON so the UI can show a
            // readable message instead of hanging.
            let body = Data(#"{"isSuccess":false,"errorMsg":"未配置阅读服务地址，请点右上角设置"}"#.utf8)
            let response = URLResponse(url: requestURL,
                                       mimeType: "application/json; charset=utf-8",
                                       expectedContentLength: body.count,
                                       textEncodingName: "utf-8")
            guard self.claim(task) else { return }
            task.didReceive(response)
            task.didReceive(body)
            task.didFinish()
            self.release(task)
            return
        }

        var components = URLComponents()
        components.scheme = base.scheme ?? "http"
        components.host = base.host
        components.port = base.port
        components.path = requestURL.path
        components.query = requestURL.query

        guard let target = components.url else {
            fail(task, code: -1, message: "bad server url")
            return
        }

        var request = URLRequest(url: target)
        request.httpMethod = task.request.httpMethod
        request.httpBody = task.request.httpBody
        request.timeoutInterval = 60

        let incoming = task.request.allHTTPHeaderFields ?? [:]
        for (key, value) in incoming {
            let lower = key.lowercased()
            if lower == "host" || lower == "origin" || lower == "referer" { continue }
            if lower.hasPrefix("sec-") { continue }
            request.setValue(value, forHTTPHeaderField: key)
        }
        request.setValue("LegadoMobile/1.0 (iOS)", forHTTPHeaderField: "User-Agent")

        let key = ObjectIdentifier(task)
        if !self.claim(task) { return }

        let dataTask = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self = self else { return }
            if let error = error {
                self.fail(task, code: -1, message: error.localizedDescription)
                return
            }
            let payload = data ?? Data()
            let status = (response as? HTTPURLResponse)?.statusCode ?? 200
            let contentType = (response as? HTTPURLResponse)?
                .value(forHTTPHeaderField: "Content-Type") ?? "application/json; charset=utf-8"

            var headers: [String: String] = [
                "Content-Type": contentType,
                "Content-Length": String(payload.count),
                "Access-Control-Allow-Origin": "*",
            ]
            if let disposition = (response as? HTTPURLResponse)?
                .value(forHTTPHeaderField: "Content-Disposition") {
                headers["Content-Disposition"] = disposition
            }
            let httpResponse = HTTPURLResponse(url: task.request.url!,
                                               statusCode: status,
                                               httpVersion: "HTTP/1.1",
                                               headerFields: headers)
            guard let finalResponse = httpResponse else {
                self.fail(task, code: -1, message: "response build failed")
                return
            }
            task.didReceive(finalResponse)
            task.didReceive(payload)
            task.didFinish()
            self.release(task)
        }

        lock.lock()
        let alreadyCancelled = cancelled.contains(key)
        if !alreadyCancelled { running[key] = dataTask }
        lock.unlock()

        if alreadyCancelled {
            release(task)
            return
        }
        dataTask.resume()
    }

    // MARK: task bookkeeping

    /// Returns false when the task was already stopped by WebKit.
    private func claim(_ task: WKURLSchemeTask) -> Bool {
        let key = ObjectIdentifier(task)
        lock.lock()
        let isCancelled = cancelled.contains(key)
        lock.unlock()
        return !isCancelled
    }

    private func release(_ task: WKURLSchemeTask) {
        let key = ObjectIdentifier(task)
        lock.lock()
        running.removeValue(forKey: key)
        cancelled.remove(key)
        lock.unlock()
    }

    private func fail(_ task: WKURLSchemeTask, code: Int, message: String) {
        let error = NSError(domain: "LegadoShell", code: code,
                            userInfo: [NSLocalizedDescriptionKey: message])
        task.didFailWithError(error)
        release(task)
    }
}

// MARK: - WebView wrapper

struct ShellWebView: UIViewRepresentable {
    let serverURL: String

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.websiteDataStore = .default()
        config.setURLSchemeHandler(LegadoSchemeHandler(), forURLScheme: legadoScheme)

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.bounces = true
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.965, green: 0.969, blue: 0.961, alpha: 1)
        webView.scrollView.backgroundColor = webView.backgroundColor
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        context.coordinator.webView = webView
        context.coordinator.loadShell(into: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // The scheme handler reads the server address per request, so a change
        // only needs a reload to pick up new data.
        context.coordinator.reloadIfServerChanged(serverURL, in: webView)
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        weak var webView: WKWebView?
        private var loadedServer = ""

        func loadShell(into webView: WKWebView) {
            guard let url = URL(string: "\(legadoScheme)://\(legadoHost)/index.html") else { return }
            loadedServer = UserDefaults.standard.string(forKey: "serverURL") ?? ""
            webView.load(URLRequest(url: url))
        }

        func reloadIfServerChanged(_ serverURL: String, in webView: WKWebView) {
            guard serverURL != loadedServer else { return }
            loadedServer = serverURL
            webView.reload()
        }

        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }
            if url.scheme == legadoScheme || url.scheme == "http" || url.scheme == "https" {
                decisionHandler(.allow)
                return
            }
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
            decisionHandler(.cancel)
        }

        func webView(_ webView: WKWebView,
                     createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction,
                     windowFeatures: WKWindowFeatures) -> WKWebView? {
            if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
                webView.load(URLRequest(url: url))
            }
            return nil
        }
    }
}

// MARK: - Setup sheet

struct SetupSheet: View {
    @EnvironmentObject private var settings: ServerSettings
    @Binding var showSetup: Bool
    var mustConfigure: Bool = false

    @State private var draft: String = ""
    @State private var reachable: Bool?
    @State private var checking = false
    @State private var didInit = false

    var body: some View {
        ZStack {
            Color.black.opacity(0.28)
                .ignoresSafeArea()
                .onTapGesture { if !mustConfigure { showSetup = false } }

            VStack(alignment: .leading, spacing: 16) {
                Text("连接阅读服务")
                    .font(.system(.title2, design: .serif))
                    .bold()

                Text("填入运行「阅读」Web 服务的地址。在本机双击「启动阅读服务.cmd」后，窗口里会显示这个地址。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                TextField("例如 电脑IP:1234", text: $draft)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.body, design: .monospaced))

                HStack(spacing: 12) {
                    Button(checking ? "检测中…" : "测试连接") {
                        Task { await probe() }
                    }
                    .disabled(checking || draft.trimmingCharacters(in: .whitespaces).isEmpty)

                    if let ok = reachable {
                        Label(ok ? "可连接" : "无法连接",
                              systemImage: ok ? "checkmark.circle" : "xmark.circle")
                            .font(.footnote)
                            .foregroundStyle(ok ? Color.green : Color.red)
                    }
                    Spacer()
                }

                Toggle("强制深色", isOn: $settings.forceDark)
                    .font(.footnote)

                HStack {
                    Spacer()
                    if !mustConfigure {
                        Button("取消") { showSetup = false }
                    }
                    Button("保存") {
                        settings.serverURL = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                        showSetup = false
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .padding(22)
            .frame(maxWidth: 460)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .padding(24)
        }
        .onAppear {
            guard !didInit else { return }
            didInit = true
            draft = settings.serverURL
        }
    }

    /// Users paste whatever the launcher prints — "10.0.0.5:1234" is as likely
    /// as "http://10.0.0.5:1234". Add the scheme when it is missing.
    static func normalise(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return s }
        if !s.lowercased().hasPrefix("http://") && !s.lowercased().hasPrefix("https://") {
            s = "http://" + s
        }
        // drop a trailing slash so path composition stays predictable
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }

    private func probe() async {
        checking = true
        defer { checking = false }
        guard var components = URLComponents(string: Self.normalise(draft)) else {
            reachable = false
            return
        }
        components.path = "/api/health"
        components.query = nil
        guard let url = components.url else {
            reachable = false
            return
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            reachable = (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            reachable = false
        }
    }
}

