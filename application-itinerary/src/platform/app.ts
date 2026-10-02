/** 应用装配，组合平台现有能力（机构/预约/审批/分录/通知/任务）。 */
import { AuditLog } from "./audit.js";
import { Database } from "./database.js";
import { Inbox } from "./inbox.js";
import { JobQueue } from "./jobs.js";
import { Ledger } from "./ledger.js";
import { Outbox } from "./outbox.js";
import { EntityRepository } from "./repository.js";
import { ReservationBook } from "./reservations.js";
import { Clock } from "./timeutil.js";

export class Platform {
  readonly clock: Clock;
  readonly audit: AuditLog;
  readonly repository: EntityRepository;
  readonly ledger: Ledger;
  readonly reservations: ReservationBook;
  readonly jobs: JobQueue;
  readonly inbox: Inbox;
  readonly outbox: Outbox;

  constructor(
    readonly database: Database,
    fixedNow?: string,
  ) {
    this.clock = new Clock(fixedNow);
    this.audit = new AuditLog(this.clock);
    this.repository = new EntityRepository(database, this.clock, this.audit);
    this.ledger = new Ledger(database, this.clock);
    this.reservations = new ReservationBook(database);
    this.jobs = new JobQueue(database, this.clock);
    this.inbox = new Inbox(database, this.clock);
    this.outbox = new Outbox(database, this.clock);
  }

  static open(path: string, fixedNow?: string): Platform {
    const database = new Database(path);
    database.initialize();
    return new Platform(database, fixedNow);
  }

  verify(): { audit_entries: number } {
    const count = this.audit.verify(this.database);
    return { audit_entries: count };
  }
}
