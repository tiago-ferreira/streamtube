import { DomainException } from '../../common/exceptions/domain.exception';

export class VideoNotFoundException extends DomainException {
  constructor(message = 'Video not found') {
    super('VIDEO_NOT_FOUND', 404, message);
  }
}

export class VideoUploadNotInProgressException extends DomainException {
  constructor(message = 'Video upload is not in progress') {
    super('VIDEO_UPLOAD_NOT_IN_PROGRESS', 409, message);
  }
}

export class InvalidUploadPartsException extends DomainException {
  constructor(message = 'Invalid upload parts') {
    super('INVALID_UPLOAD_PARTS', 400, message);
  }
}

export class UploadSizeMismatchException extends DomainException {
  constructor(
    message = 'Uploaded object size does not match declared size_bytes',
  ) {
    super('UPLOAD_SIZE_MISMATCH', 422, message);
  }
}
