"""请求幂等记录。"""

from __future__ import annotations

import functools
import json
import sqlite3
from dataclasses import dataclass
from typing import Any, Callable, TypeVar

from .errors import ConflictError
from .jsonutil import canonical_json, digest_json
from .timeutil import Clock

T = TypeVar("T")


@dataclass(frozen=True)
class IdempotencyStore:
    clock: Clock

    def execute(self, connection: sqlite3.Connection, *, scope: str, request_key: str, request: dict, operation: Callable[[], T]) -> T:
        request_digest = digest_json(request)
        row = connection.execute("SELECT request_digest,response_json FROM idempotency_keys WHERE scope=? AND request_key=?", (scope, request_key)).fetchone()
        if row:
            if row["request_digest"] != request_digest:
                raise ConflictError("相同请求标识对应不同内容")
            return json.loads(row["response_json"])
        response = operation()
        connection.execute("INSERT INTO idempotency_keys(scope,request_key,request_digest,response_json,created_at) VALUES(?,?,?,?,?)", (scope, request_key, request_digest, canonical_json(response), self.clock.now()))
        return response

    def peek(self, connection: sqlite3.Connection, *, scope: str, request_key: str, request: dict) -> Any | None:
        """返回此前编排请求缓存的响应；键存在但内容不同则冲突。"""
        request_digest = digest_json(request)
        row = connection.execute("SELECT request_digest,response_json FROM idempotency_keys WHERE scope=? AND request_key=?", (scope, request_key)).fetchone()
        if not row:
            return None
        if row["request_digest"] != request_digest:
            raise ConflictError("相同请求标识对应不同内容")
        return json.loads(row["response_json"])

    def store(self, connection: sqlite3.Connection, *, scope: str, request_key: str, request: dict, response: Any) -> None:
        connection.execute("INSERT OR IGNORE INTO idempotency_keys(scope,request_key,request_digest,response_json,created_at) VALUES(?,?,?,?,?)", (scope, request_key, digest_json(request), canonical_json(response), self.clock.now()))


def idempotent(scope: str) -> Callable[[Callable[..., T]], Callable[..., T]]:
    """编排级幂等：保护跨实体写入、容量占用与通知发送等一组副作用。

    被装饰方法必须以 (self, context, ...) 调用且带 request_key 关键字参数，
    self 需持有 repository（具备 database/idempotency/clock）。
    """

    def decorate(fn: Callable[..., T]) -> Callable[..., T]:
        @functools.wraps(fn)
        def wrapper(self, context, *args: object, **kwargs: object) -> T:
            request_key = kwargs.pop("request_key", None)
            if not isinstance(request_key, str) or not request_key:
                raise ConflictError("写操作必须提供 request_key")
            request = {"actor": getattr(context, "actor_id", None), "args": list(args), "kwargs": {k: v for k, v in sorted(kwargs.items()) if k != "expected_version"}}
            store = self.repository
            with store.database.connect() as connection:
                cached = store.idempotency.peek(connection, scope=scope, request_key=request_key, request=request)
            if cached is not None:
                return cached
            response = fn(self, context, *args, request_key=request_key, **kwargs)
            with store.database.transaction() as connection:
                store.idempotency.store(connection, scope=scope, request_key=request_key, request=request, response=response)
            return response

        return wrapper

    return decorate
