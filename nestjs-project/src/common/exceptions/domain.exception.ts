export abstract class DomainException extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotOwnedException extends DomainException {
  constructor() {
    super('VIDEO_NOT_OWNED', 403, 'You do not own this video');
  }
}

export class VideoInvalidStateException extends DomainException {
  constructor(
    public readonly current: string,
    public readonly expected: string[],
    message = 'Video is not in a valid state for this operation',
  ) {
    super('VIDEO_INVALID_STATE', 409, message);
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready for playback');
  }
}

export class UploadLimitReachedException extends DomainException {
  constructor(public readonly limit: number) {
    super(
      'UPLOAD_LIMIT_REACHED',
      409,
      'Too many uploads in progress for this channel',
    );
  }
}

export class UnsupportedMediaTypeException extends DomainException {
  constructor() {
    super('UNSUPPORTED_MEDIA_TYPE', 415, 'Unsupported media type');
  }
}

export class UploadIncompleteException extends DomainException {
  constructor(message = 'Uploaded parts do not match the expected upload') {
    super('UPLOAD_INCOMPLETE', 409, message);
  }
}

export class StorageUnavailableException extends DomainException {
  constructor() {
    super('STORAGE_UNAVAILABLE', 503, 'Storage service is unavailable');
  }
}
