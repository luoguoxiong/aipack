// apps/ai_office_agent/src-tauri/src/main.rs
// AI Office Agent 桌面端外壳(Tauri):
//   - 启动本机 Node 服务(ai_office_agent 的 dist/server.js)作为后端
//   - 窗口直接加载 http://127.0.0.1:<动态端口>(同源,零 CORS 改造)
//   - 原生目录选择器 pick_workspace_dir:前端直连本地工作区,免上传
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

/// 后端 Node 服务子进程(应用退出时清理)
struct ServerProcess(Mutex<Option<Child>>);

/// 原生目录选择器:返回用户选中的目录绝对路径(取消则 None)
/// 注意必须为 async:Tauri 同步命令跑在主线程,blocking 对话框会死锁导致界面卡死
#[tauri::command]
async fn pick_workspace_dir(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = app.dialog().file().blocking_pick_folder();
    Ok(picked.and_then(|p| p.as_path().map(|x| x.to_string_lossy().to_string())))
}

/// 获取一个随机空闲端口(bind 后立即释放,供后端服务监听)
fn free_port() -> u16 {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(3001)
}

/// 应用目录(debug 构建:exe 在 <app>/src-tauri/target/debug/,向上 3 级回到 <app>)
fn app_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("../../..")
}

/// 启动后端 Node 服务子进程
fn spawn_server(port: u16) -> Result<Child, String> {
    let node = std::env::var("AIPACK_OFFICE_NODE").unwrap_or_else(|_| "node".into());
    let entry = std::env::var("AIPACK_OFFICE_SERVER_ENTRY")
        .unwrap_or_else(|_| app_dir().join("dist/server.js").to_string_lossy().to_string());
    let cwd = app_dir();
    Command::new(&node)
        .arg(&entry)
        .current_dir(&cwd)
        .env("PORT", port.to_string())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("启动后端服务失败(node={node}, entry={entry}): {e}"))
}

/// 轮询等待后端服务端口就绪
fn wait_ready(port: u16, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    loop {
        if std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok() {
            return Ok(());
        }
        if Instant::now() > deadline {
            return Err(format!("等待后端服务就绪超时(port={port})"));
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

fn main() {
    tauri::Builder::default()
        .manage(ServerProcess(Mutex::new(None)))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![pick_workspace_dir])
        .setup(|app| {
            let port = free_port();
            let child = spawn_server(port).map_err(std::io::Error::other)?;
            *app.state::<ServerProcess>().0.lock().unwrap() = Some(child);
            wait_ready(port, Duration::from_secs(30)).map_err(std::io::Error::other)?;

            let url: tauri::Url = format!("http://127.0.0.1:{port}").parse().unwrap();
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url))
                .title("AI Office Agent")
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 640.0)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(mut child) = app_handle.state::<ServerProcess>().0.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
