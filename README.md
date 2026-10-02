# 协同事务平台

协同事务平台为需要多机构参与的业务提供统一的机构、授权、案件、证据、审批、资源预约、资金分录、消息归并、通知、定时任务和历史回放能力。项目只使用 Python 标准库与 SQLite，适合在单个 Linux 应用容器内运行。

## 目录

- `src/civicflow/`：领域服务、SQLite 持久化、权限和命令行入口。
- `tests/`：核心流程、边界条件和异常路径测试。
- `examples/`：本地演示输入。

## 配置

通过 `CIVICFLOW_DB` 指定 SQLite 文件路径；不设置时命令行使用当前目录下的 `civicflow.sqlite3`。所有时间使用带时区的 ISO 8601 字符串。

## 测试

```bash
PYTHONPATH=src python3 -m unittest discover -s tests -v
```

## 编译或构建

```bash
PYTHONPATH=src python3 -m compileall -q src
```

## 使用

初始化数据库并运行离线演示：

```bash
PYTHONPATH=src python3 -m civicflow.cli --db /tmp/civicflow-demo.sqlite3 demo
```

查看当前案件：

```bash
PYTHONPATH=src python3 -m civicflow.cli --db /tmp/civicflow-demo.sqlite3 list-cases
```

## 线路版本与服务恢复应用

在现有协同平台能力（机构、版本化实体、预约、审批、不可变资金分录、通知、
可恢复任务）之上构建的旅游履约应用位于 [`application-itinerary/`](application-itinerary/README.md)：
面向每位游客冻结实际购买的线路版本，航班改期/供应商退出/容量缩减/目的地风险
只处理未履行环节，替代同时比较时间、价值与无障碍，补差退款代金逐环节守恒，
高额补偿双人审核，供应商只见本方任务，重复回执不二次退款，矛盾消息先挂起核对，
临近出发、待确认替代与退款对账在应用重启后自动续接。

```bash
cd application-itinerary
npm install && npm run build && npm test
ITINERARY_DB=/tmp/itinerary.sqlite3 PORT=8080 npm start
```

