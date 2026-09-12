import { ArgumentsHost } from '@nestjs/common';
import { DomainExceptionFilter } from './domain-exception.filter';
import {
  EmailAlreadyExistsException,
  EmailNotConfirmedException,
  InvalidCredentialsException,
  InvalidTokenException,
  StorageUnavailableException,
  TokenExpiredException,
  TokenReuseDetectedException,
  UnsupportedMediaTypeException,
  UploadIncompleteException,
  UploadLimitReachedException,
  VideoInvalidStateException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoNotReadyException,
} from '../exceptions/domain.exception';

describe('DomainExceptionFilter', () => {
  let filter: DomainExceptionFilter;
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    filter = new DomainExceptionFilter();
    mockJson = jest.fn();
    mockStatus = jest.fn().mockReturnValue({ json: mockJson });

    mockHost = {
      switchToHttp: () => ({
        getResponse: () => ({ status: mockStatus }),
        getRequest: () => ({ url: '/test', method: 'POST' }),
      }),
      getArgs: () => [],
      getArgByIndex: () => null,
      switchToRpc: () => ({}) as any,
      switchToWs: () => ({}) as any,
      getType: () => 'http',
    } as unknown as ArgumentsHost;
  });

  it('maps EmailAlreadyExistsException to 409 with EMAIL_ALREADY_EXISTS', () => {
    filter.catch(new EmailAlreadyExistsException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(409);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 409,
      error: 'EMAIL_ALREADY_EXISTS',
      message: 'Email is already registered',
    });
  });

  it('maps InvalidCredentialsException to 401 with INVALID_CREDENTIALS', () => {
    filter.catch(new InvalidCredentialsException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 401,
      error: 'INVALID_CREDENTIALS',
      message: expect.any(String),
    });
  });

  it('maps EmailNotConfirmedException to 403 with EMAIL_NOT_CONFIRMED', () => {
    filter.catch(new EmailNotConfirmedException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(403);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 403,
      error: 'EMAIL_NOT_CONFIRMED',
      message: expect.any(String),
    });
  });

  it('maps InvalidTokenException to 401 with INVALID_TOKEN', () => {
    filter.catch(new InvalidTokenException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 401,
      error: 'INVALID_TOKEN',
      message: expect.any(String),
    });
  });

  it('maps TokenExpiredException to 401 with TOKEN_EXPIRED', () => {
    filter.catch(new TokenExpiredException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 401,
      error: 'TOKEN_EXPIRED',
      message: expect.any(String),
    });
  });

  it('maps TokenReuseDetectedException to 401 with TOKEN_REUSE_DETECTED', () => {
    filter.catch(new TokenReuseDetectedException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 401,
      error: 'TOKEN_REUSE_DETECTED',
      message: expect.any(String),
    });
  });

  it('maps VideoNotFoundException to 404 with VIDEO_NOT_FOUND', () => {
    filter.catch(new VideoNotFoundException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(404);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 404,
      error: 'VIDEO_NOT_FOUND',
      message: 'Video not found',
    });
  });

  it('maps VideoNotOwnedException to 403 with VIDEO_NOT_OWNED', () => {
    filter.catch(new VideoNotOwnedException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(403);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 403,
      error: 'VIDEO_NOT_OWNED',
      message: 'You do not own this video',
    });
  });

  it('maps VideoInvalidStateException to 409 with VIDEO_INVALID_STATE', () => {
    filter.catch(
      new VideoInvalidStateException('ready', ['uploading']),
      mockHost,
    );

    expect(mockStatus).toHaveBeenCalledWith(409);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 409,
      error: 'VIDEO_INVALID_STATE',
      message: 'Video is not in a valid state for this operation',
    });
  });

  it('maps VideoNotReadyException to 409 with VIDEO_NOT_READY', () => {
    filter.catch(new VideoNotReadyException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(409);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 409,
      error: 'VIDEO_NOT_READY',
      message: 'Video is not ready for playback',
    });
  });

  it('maps UploadLimitReachedException to 409 with UPLOAD_LIMIT_REACHED', () => {
    filter.catch(new UploadLimitReachedException(5), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(409);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 409,
      error: 'UPLOAD_LIMIT_REACHED',
      message: 'Too many uploads in progress for this channel',
    });
  });

  it('maps UnsupportedMediaTypeException to 415 with UNSUPPORTED_MEDIA_TYPE', () => {
    filter.catch(new UnsupportedMediaTypeException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(415);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 415,
      error: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'Unsupported media type',
    });
  });

  it('maps UploadIncompleteException to 409 with UPLOAD_INCOMPLETE', () => {
    filter.catch(new UploadIncompleteException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(409);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 409,
      error: 'UPLOAD_INCOMPLETE',
      message: 'Uploaded parts do not match the expected upload',
    });
  });

  it('maps StorageUnavailableException to 503 with STORAGE_UNAVAILABLE', () => {
    filter.catch(new StorageUnavailableException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(503);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 503,
      error: 'STORAGE_UNAVAILABLE',
      message: 'Storage service is unavailable',
    });
  });
});
