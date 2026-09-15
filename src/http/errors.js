// Errors that carry an HTTP status. Thrown by guards and handlers, rendered by app.js.

export class HttpError extends Error {
  constructor(status, messageKey = `error.${status}`, vars = {}) {
    super(messageKey);
    this.status = status;
    this.messageKey = messageKey;
    this.vars = vars;
  }
}

/** A user-facing validation problem (bad input, broken rule). Rendered as 400 or inline. */
export class ValidationError extends HttpError {
  constructor(messageKey, vars = {}) {
    super(400, messageKey, vars);
  }
}
