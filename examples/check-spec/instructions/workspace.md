读取前序项目分类。single repo 无需 workspace 配置；
monorepo 按 Rules 核对根 pnpm-workspace.yaml 的普通文件类型、YAML 对象及 packages 数组，
报告准确字段，不执行成员命令。
