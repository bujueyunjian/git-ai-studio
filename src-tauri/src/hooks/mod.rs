//! Hooks 配置管理(模块 3):依赖上游 `git-ai install-hooks` 写入官方 hooks + settings.json 合并 + 备份。

pub mod backups;
pub mod model;
pub mod settings_json;
