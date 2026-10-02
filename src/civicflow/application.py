"""应用装配。"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .audit import AuditLog
from .approvals import ApprovalService
from .database import Database
from .idempotency import IdempotencyStore
from .inbox import Inbox
from .jobs import JobQueue
from .ledger import Ledger
from .outbox import Outbox
from .recovery import RecoveryService
from .repository import EntityRepository
from .reservations import ReservationBook
from .timeutil import Clock
from .tours import TourService


@dataclass(frozen=True)
class CivicFlow:
    database: Database
    clock: Clock
    repository: EntityRepository
    inbox: Inbox
    outbox: Outbox
    ledger: Ledger
    reservations: ReservationBook
    jobs: JobQueue
    approvals: ApprovalService
    tours: TourService
    recovery: RecoveryService

    @classmethod
    def open(cls, path: str | Path, *, fixed_now: str | None = None) -> "CivicFlow":
        database = Database(path); database.initialize(); clock = Clock(fixed_now)
        audit = AuditLog(clock); idempotency = IdempotencyStore(clock)
        repository = EntityRepository(database, clock, audit, idempotency)
        inbox = Inbox(database, clock); outbox = Outbox(database, clock)
        ledger = Ledger(database, clock); reservations = ReservationBook(database); jobs = JobQueue(database, clock)
        approvals = ApprovalService(repository)
        tours = TourService(repository, reservations)
        recovery_service = RecoveryService(repository, reservations, approvals, outbox, inbox, jobs)
        return cls(database, clock, repository, inbox, outbox, ledger, reservations, jobs, approvals, tours, recovery_service)

    def verify(self) -> dict:
        with self.database.connect() as connection:
            audit_count = AuditLog(self.clock).verify(connection)
            entity_count = connection.execute("SELECT COUNT(*) AS n FROM entities").fetchone()["n"]
            conflict_count = connection.execute("SELECT COUNT(*) AS n FROM inbox_conflicts").fetchone()["n"]
        return {"audit_entries": audit_count, "entities": entity_count, "inbox_conflicts": conflict_count}
