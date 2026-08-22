# CSST 仿真资源在 Atlas 中的边界

CSST 公共覆盖的计算、审核、锁定和发布属于 Assets。Atlas 不提交 CSST
公共 coverage task，也不读取 OSS 凭据或重新计算已有 CSST 制品。

Atlas 只做以下事情：

- 通过 Assets Resource Package v3 catalog 同步已发布的 CSST 包；
- 校验包内 manifest、文件大小、SHA-256 和 FITS MOC 合同；
- 以公共 survey/release 图层展示包中的 order-8 查询投影和 order-4 预览；
- 将用户自己注册的 CSST 文件作为 `origin=user` 资产处理，用户扫描结果只
  写入 Atlas 的索引和任务历史。

现有 CSST W1-W4 用户资产、任务记录、MOC 像元和 SHA-256 是历史数据，清理
代码时不得修改、重算或覆盖。若某个 release 尚未出现在 Assets 公共包中，
它仍可作为 Atlas 本地用户标签存在，不会因此自动成为公共资源。

本文件不再记录公共扫描命令。公共任务的 connector、recipe、MOC finalizer
和发布流程由 Assets 项目维护。
