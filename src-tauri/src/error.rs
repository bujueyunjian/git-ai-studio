use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("git-ai 未找到 (检查过 GIT_AI_PATH / ~/.git-ai/bin / 系统 PATH)")]
    GitAiNotFound,
    #[error("git-ai 执行失败 (退出码 {code}): {stderr}")]
    GitAiFailed { code: i32, stderr: String },
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, AppError>;

impl From<AppError> for String {
    fn from(e: AppError) -> Self {
        e.to_string()
    }
}
