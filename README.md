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

旅游线路版本与服务恢复：

```bash
PYTHONPATH=src python3 -m civicflow.cli --db /tmp/civicflow-demo.sqlite3 tour-demo
```

- `tours.py`：出发批次目录（逐日行程、交通住宿与活动供应、容量、价格构成、签证入境条件、导游资质、特殊需求、允许替代范围）与游客订单；游客确认后冻结实际购买版本并占座。
- `recovery.py`：供应商退出、容量缩减、目的地风险或航班变化只处理尚未履行的环节，已使用服务保留原责任；替代方案逐项比较时间、价值与无障碍条件，补差/退款/代金与被影响项目一一对应并登记不可变分录；高额补偿必须另一人复核（四眼）；供应商状态回执重复不触发第二次退款，矛盾消息挂起待核；供应商只见本方任务；临近出发提醒、替代确认超时与退款对账经持久化任务队列在重启后自动续接。游客可查看变更原因与权益计算（`tourist_view`），运营可据 `operator_queue` 确定下一责任方。
