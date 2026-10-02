/** 领域异常，与协同平台 civicflow.errors 对应。 */
export class CivicError extends Error {
}
export class ValidationError extends CivicError {
}
export class ConflictError extends CivicError {
}
export class NotFoundError extends CivicError {
}
export class PermissionDenied extends CivicError {
}
export class InvariantViolation extends CivicError {
}
