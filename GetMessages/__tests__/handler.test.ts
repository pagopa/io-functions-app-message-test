// eslint-disable @typescript-eslint/no-explicit-any, sonarjs/no-duplicate-string, sonar/sonar-max-lines-per-function

import * as E from "fp-ts/lib/Either";
import * as O from "fp-ts/lib/Option";
import * as TE from "fp-ts/lib/TaskEither";
import * as RA from "fp-ts/ReadonlyArray";
import * as t from "io-ts";

import { FiscalCode, NonEmptyString } from "@pagopa/ts-commons/lib/strings";
import {
  MessageModel,
  NewMessageWithoutContent,
  RetrievedMessageWithoutContent
} from "@pagopa/io-functions-commons/dist/src/models/message";
import { TimeToLiveSeconds } from "@pagopa/io-functions-commons/dist/generated/definitions/TimeToLiveSeconds";
import { retrievedMessageToPublic } from "@pagopa/io-functions-commons/dist/src/utils/messages";
import { NonNegativeInteger } from "@pagopa/ts-commons/lib/numbers";
import { aCosmosResourceMetadata } from "../../__mocks__/mocks";
import {
  aRetrievedService,
  aServiceId
} from "../../__mocks__/mocks.service_preference";
import { GetMessagesHandler } from "../handler";
import { MessageContent } from "@pagopa/io-functions-commons/dist/generated/definitions/MessageContent";
import { BlobService } from "azure-storage";
import {
  RetrievedService,
  ServiceModel
} from "@pagopa/io-functions-commons/dist/src/models/service";
import {
  CosmosErrors,
  toCosmosErrorResponse
} from "@pagopa/io-functions-commons/dist/src/utils/cosmosdb_model";
import { Context } from "@azure/functions";
import { TagEnum as TagEnumBase } from "@pagopa/io-functions-commons/dist/generated/definitions/MessageCategoryBase";
import { RetrievedMessageStatus } from "@pagopa/io-functions-commons/dist/src/models/message_status";
import { MessageStatusValueEnum } from "@pagopa/io-functions-commons/dist/generated/definitions/MessageStatusValue";
import { MessageStatusExtendedQueryModel } from "../../model/message_status_query";
import { pipe } from "fp-ts/lib/function";
import * as redis from "../../utils/redis_storage";
import { createGetMessagesFunctionSelection } from "../getMessagesFunctions/getMessages.selector";
import { MessageViewExtendedQueryModel } from "../../model/message_view_query";
import { RetrievedMessageView } from "@pagopa/io-functions-commons/dist/src/models/message_view";
import { toEnrichedMessageWithContent } from "../getMessagesFunctions/getMessages.view";

const aFiscalCode = "FRLFRC74E04B157I" as FiscalCode;
const aMessageId = "A_MESSAGE_ID" as NonEmptyString;
const aPendingMessageId = "A_PENDING_MESSAGE_ID" as NonEmptyString;

const aRetrievedMessageStatus: RetrievedMessageStatus = {
  ...aCosmosResourceMetadata,
  id: "1" as NonEmptyString,
  messageId: "1" as NonEmptyString,
  status: MessageStatusValueEnum.PROCESSED,
  updatedAt: new Date(),
  version: 2 as NonNegativeInteger,
  isRead: false,
  isArchived: false,
  kind: "IRetrievedMessageStatus"
};

const aNewMessageWithoutContent: NewMessageWithoutContent = {
  createdAt: new Date(),
  fiscalCode: aFiscalCode,
  id: aMessageId,
  indexedId: "A_MESSAGE_ID" as NonEmptyString,
  isPending: false,
  kind: "INewMessageWithoutContent",
  senderServiceId: aServiceId,
  senderUserId: "u123" as NonEmptyString,
  timeToLiveSeconds: 3600 as TimeToLiveSeconds
};

const aRetrievedMessageWithoutContent: RetrievedMessageWithoutContent = {
  ...aNewMessageWithoutContent,
  ...aCosmosResourceMetadata,
  kind: "IRetrievedMessageWithoutContent"
};

const aRetrievedPendingMessageWithoutContent: RetrievedMessageWithoutContent = {
  ...aNewMessageWithoutContent,
  ...aCosmosResourceMetadata,
  id: aPendingMessageId,
  isPending: true,
  kind: "IRetrievedMessageWithoutContent"
};

const aRetrievedMessageView: RetrievedMessageView = pipe(
  RetrievedMessageView.decode({
    ...aCosmosResourceMetadata,
    components: {
      attachments: {
        has: false
      },
      euCovidCert: {
        has: false
      },
      legalData: {
        has: false
      },
      payment: {
        has: true,
        notice_number: "177777777777777777"
      }
    },
    createdAt: "2021-05-09T14:55:52.206Z",
    fiscalCode: aFiscalCode,
    id: "aMessageId",
    messageTitle: "reprehenderit unde rerum ea officiis",
    senderServiceId: aRetrievedService.serviceId,
    status: {
      archived: false,
      processing: "PROCESSED",
      read: false
    },
    version: 0,
    timeToLive: 3600
  }),
  E.getOrElseW(() => {
    throw Error("wrong RetrievedMessageView");
  })
);

//----------------------------
// Mocks
//----------------------------

const blobServiceMock = ({
  getBlobToText: jest.fn()
} as unknown) as BlobService;

const getMockIterator = values => ({
  next: jest
    .fn()
    .mockImplementationOnce(async () => ({
      value: values
    }))
    .mockImplementationOnce(async () => ({ done: true }))
});

const getMessageModelMock = messageIterator =>
  (({
    getContentFromBlob: () =>
      TE.of(
        O.some({
          subject: "a subject",
          markdown: "a markdown"
        } as MessageContent)
      ),
    findMessages: jest.fn(() => TE.of(messageIterator))
  } as unknown) as MessageModel);

const errorMessageModelMock = ({
  getContentFromBlob: jest.fn(() => TE.left("Error blob")),
  findMessages: jest.fn(() => TE.left(toCosmosErrorResponse("Not found")))
} as unknown) as MessageModel;

const mockFindLastVersionByModelId = jest.fn(() =>
  TE.of<CosmosErrors, O.Option<RetrievedService>>(O.some(aRetrievedService))
);
const serviceModelMock = ({
  findLastVersionByModelId: mockFindLastVersionByModelId
} as unknown) as ServiceModel;

const functionsContextMock = ({
  log: {
    error: jest.fn(console.log)
  }
} as unknown) as Context;

/**
 * Build a service list iterator
 */
async function* buildIterator<A, I extends unknown, O extends unknown>(
  codec: t.Type<A, I, O>,
  list: ReadonlyArray<O>,
  onNewPage?: (i: number) => void,
  errorToThrow?: CosmosErrors | Error
): AsyncIterable<ReadonlyArray<t.Validation<A>>> {
  // eslint-disable-next-line functional/no-let

  if (errorToThrow) {
    throw errorToThrow;
  }

  let i = 0;
  for (const p of pipe(list, RA.map(codec.decode), RA.chunksOf(2))) {
    yield p;
    if (onNewPage) onNewPage(i);
    i++;
  }
}

// MessageStatus Mocks
const mockFindAllVersionsByModelIdIn = jest.fn((ids: string[]) => {
  return buildIterator(
    RetrievedMessageStatus,
    ids.map(id => ({ ...aRetrievedMessageStatus, messageId: id }))
  );
});

const messageStatusModelMock = ({
  findAllVersionsByModelIdIn: mockFindAllVersionsByModelIdIn
} as unknown) as MessageStatusExtendedQueryModel;

// MessageView Mocks
const mockQueryPage = jest.fn(_ => {
  return TE.of<
    CosmosErrors,
    AsyncIterable<ReadonlyArray<t.Validation<RetrievedMessageView>>>
  >(
    buildIterator(
      RetrievedMessageView,
      Array.from({ length: 1 }, _ => aRetrievedMessageView)
    )
  );
});
const messageViewModelMock = ({
  queryPage: mockQueryPage
} as unknown) as MessageViewExtendedQueryModel;

const setWithExpirationTaskMock = jest.fn(() => TE.of<Error, true>(true));
jest
  .spyOn(redis, "setWithExpirationTask")
  .mockImplementation(setWithExpirationTaskMock);

const getTaskMock = jest.fn(() =>
  TE.of(O.some(JSON.stringify(aRetrievedService)))
);
jest.spyOn(redis, "getTask").mockImplementation(getTaskMock);

const aRedisClient = {} as any;
const aServiceCacheTtl = 10 as NonNegativeInteger;

// ---------------------
// Tests
// ---------------------

describe("GetMessagesHandler |> Fallback |> No Enrichment", () => {
  const aSimpleList = [
    aRetrievedMessageWithoutContent,
    aRetrievedMessageWithoutContent,
    aRetrievedMessageWithoutContent,
    aRetrievedMessageWithoutContent,
    aRetrievedMessageWithoutContent,
    aRetrievedPendingMessageWithoutContent
  ];
  const aMessageList = aSimpleList.map(m => E.right(m));

  beforeEach(() => jest.clearAllMocks());

  it("should respond with query error if it cannot retrieve messages", async () => {
    const getMessagesFunctionSelector = createGetMessagesFunctionSelection(
      false,
      "none",
      [errorMessageModelMock, messageStatusModelMock, blobServiceMock],
      [messageViewModelMock]
    );

    const getMessagesHandler = GetMessagesHandler(
      getMessagesFunctionSelector,
      serviceModelMock,
      aRedisClient,
      aServiceCacheTtl
    );

    const result = await getMessagesHandler(
      functionsContextMock,
      aFiscalCode,
      O.none,
      O.none,
      O.none,
      O.none,
      O.none
    );
    expect(result.kind).toBe("IResponseErrorQuery");
    expect(functionsContextMock.log.error).not.toHaveBeenCalled();
  });

  it("should respond with the messages for the recipient when no parameters are given", async () => {
    const messages = [E.right(aRetrievedMessageWithoutContent)];
    const messageIterator = getMockIterator(messages);
    const messageModelMock = getMessageModelMock(messageIterator);

    const getMessagesFunctionSelector = createGetMessagesFunctionSelection(
      false,
      "none",
      [messageModelMock, messageStatusModelMock, blobServiceMock],
      [messageViewModelMock]
    );

    const getMessagesHandler = GetMessagesHandler(
      getMessagesFunctionSelector,
      serviceModelMock,
      aRedisClient,
      aServiceCacheTtl
    );

    const result = await getMessagesHandler(
      functionsContextMock,
      aFiscalCode,
      O.none,
      O.none,
      O.none,
      O.none,
      O.none
    );
    expect(result.kind).toBe("IResponseSuccessJson");
    expect(messageIterator.next).toHaveBeenCalledTimes(2);
    expect(functionsContextMock.log.error).not.toHaveBeenCalled();
  });

  it("should respond only with non-pending messages", async () => {
    const messages = [
      E.right(aRetrievedMessageWithoutContent),
      E.right(aRetrievedPendingMessageWithoutContent)
    ];
    const messageIterator = getMockIterator(messages);
    const messageModelMock = getMessageModelMock(messageIterator);

    const getMessagesFunctionSelector = createGetMessagesFunctionSelection(
      false,
      "none",
      [messageModelMock, messageStatusModelMock, blobServiceMock],
      [messageViewModelMock]
    );

    const getMessagesHandler = GetMessagesHandler(
      getMessagesFunctionSelector,
      serviceModelMock,
      aRedisClient,
      aServiceCacheTtl
    );

    const result = await getMessagesHandler(
      functionsContextMock,
      aFiscalCode,
      O.none,
      O.none,
      O.none,
      O.none,
      O.none
    );
    expect(result.kind).toBe("IResponseSuccessJson");

    if (result.kind === "IResponseSuccessJson") {
      expect(result.value).toEqual({
        items: [retrievedMessageToPublic(aRetrievedMessageWithoutContent)],
        prev: aRetrievedMessageWithoutContent.id,
        next: undefined
      });
    }

    expect(messageIterator.next).toHaveBeenCalledTimes(2);
    expect(functionsContextMock.log.error).not.toHaveBeenCalled();
  });

  it("should respond with a page of given page size", async () => {
    const messageIterator = getMockIterator(aMessageList);
    const messageModelMock = getMessageModelMock(messageIterator);

    const getMessagesFunctionSelector = createGetMessagesFunctionSelection(
      false,
      "none",
      [messageModelMock, messageStatusModelMock, blobServiceMock],
      [messageViewModelMock]
    );

    const getMessagesHandler = GetMessagesHandler(
      getMessagesFunctionSelector,
      serviceModelMock,
      aRedisClient,
      aServiceCacheTtl
    );

    const pageSize = 2 as NonNegativeInteger;

    const result = await getMessagesHandler(
      functionsContextMock,
      aFiscalCode,
      O.some(pageSize),
      O.none,
      O.none,
      O.none,
      O.none
    );

    expect(result.kind).toBe("IResponseSuccessJson");

    if (result.kind === "IResponseSuccessJson") {
      expect(result.value).toEqual({
        items: [
          aRetrievedMessageWithoutContent,
          aRetrievedMessageWithoutContent
        ].map(retrievedMessageToPublic),
        prev: aSimpleList[0].id,
        next: aSimpleList[2].id
      });
    }

    expect(messageIterator.next).toHaveBeenCalledTimes(1);
    expect(functionsContextMock.log.error).not.toHaveBeenCalled();
  });

  it("should respond with a page of messages when given maximum id", async () => {
    const messageIterator = getMockIterator(aMessageList);
    const messageModelMock = getMessageModelMock(messageIterator);

    const getMessagesFunctionSelector = createGetMessagesFunctionSelection(
      false,
      "none",
      [messageModelMock, messageStatusModelMock, blobServiceMock],
      [messageViewModelMock]
    );

    const getMessagesHandler = GetMessagesHandler(
      getMessagesFunctionSelector,
      serviceModelMock,
      aRedisClient,
      aServiceCacheTtl
    );

    const pageSize = 2 as NonNegativeInteger;

    const result = await getMessagesHandler(
      functionsContextMock,
      aFiscalCode,
      O.some(pageSize),
      O.none,
      O.none,
      O.some(aRetrievedMessageWithoutContent.id),
      O.none
    );
    expect(result.kind).toBe("IResponseSuccessJson");

    if (result.kind === "IResponseSuccessJson") {
      expect(result.value).toEqual({
        items: [
          aRetrievedMessageWithoutContent,
          aRetrievedMessageWithoutContent
        ].map(retrievedMessageToPublic),
        prev: aRetrievedMessageWithoutContent.id,
        next: aRetrievedMessageWithoutContent.id
      });
    }

    expect(messageIterator.next).toHaveBeenCalledTimes(1);
    expect(functionsContextMock.log.error).not.toHaveBeenCalled();
  });

  it("should respond with a page of messages above given minimum id", async () => {
    const messageIterator = getMockIterator(aMessageList);
    const messageModelMock = getMessageModelMock(messageIterator);

    const getMessagesFunctionSelector = createGetMessagesFunctionSelection(
      false,
      "none",
      [messageModelMock, messageStatusModelMock, blobServiceMock],
      [messageViewModelMock]
    );

    const getMessagesHandler = GetMessagesHandler(
      getMessagesFunctionSelector,
      serviceModelMock,
      aRedisClient,
      aServiceCacheTtl
    );

    const pageSize = 2 as NonNegativeInteger;

    const result = await getMessagesHandler(
      functionsContextMock,
      aFiscalCode,
      O.some(pageSize),
      O.none,
      O.none,
      O.none,
      O.some(aRetrievedMessageWithoutContent.id)
    );

    expect(result.kind).toBe("IResponseSuccessJson");

    if (result.kind === "IResponseSuccessJson") {
      expect(result.value).toEqual({
        items: [
          aRetrievedMessageWithoutContent,
          aRetrievedMessageWithoutContent
        ].map(retrievedMessageToPublic),
        prev: aRetrievedMessageWithoutContent.id,
        next: aRetrievedMessageWithoutContent.id
      });
    }

    expect(messageIterator.next).toHaveBeenCalledTimes(1);
    expect(functionsContextMock.log.error).not.toHaveBeenCalled();
  });

  it("should respond with undefined next when last element of the page is the last of all", async () => {
    const messages = [
      E.right(aRetrievedMessageWithoutContent),
      E.right(aRetrievedMessageWithoutContent)
    ];
    const messageIterator = getMockIterator(messages);
    const messageModelMock = getMessageModelMock(messageIterator);

    const getMessagesFunctionSelector = createGetMessagesFunctionSelection(
      false,
      "none",
      [messageModelMock, messageStatusModelMock, blobServiceMock],
      [messageViewModelMock]
    );

    const getMessagesHandler = GetMessagesHandler(
      getMessagesFunctionSelector,
      serviceModelMock,
      aRedisClient,
      aServiceCacheTtl
    );

    const pageSize = 2 as NonNegativeInteger;

    const result = await getMessagesHandler(
      functionsContextMock,
      aFiscalCode,
      O.some(pageSize),
      O.none,
      O.none,
      O.none,
      O.some(aRetrievedMessageWithoutContent.id)
    );

    expect(result.kind).toBe("IResponseSuccessJson");

    if (result.kind === "IResponseSuccessJson") {
      expect(result.value).toEqual({
        items: [
          aRetrievedMessageWithoutContent,
          aRetrievedMessageWithoutContent
        ].map(retrievedMessageToPublic),
        prev: aRetrievedMessageWithoutContent.id,
        next: undefined
      });
    }

    expect(messageIterator.next).toHaveBeenCalledTimes(2);
    expect(functionsContextMock.log.error).not.toHaveBeenCalled();
  });
});

describe("GetMessagesHandler |> Fallback |> Enrichment", () => {
  const aSimpleList = [
    {
      ...aRetrievedMessageWithoutContent,
      id: "aMessageId_5" as NonEmptyString
    },
    {
      ...aRetrievedMessageWithoutContent,
      id: "aMessageId_4" as NonEmptyString
    },
    {
      ...aRetrievedMessageWithoutContent,
      id: "aMessageId_3" as NonEmptyString
    },
    {
      ...aRetrievedMessageWithoutContent,
      id: "aMessageId_2" as NonEmptyString
    },
    {
      ...aRetrievedMessageWithoutContent,
      id: "aMessageId_1" as NonEmptyString
    },
    {
      ...aRetrievedPendingMessageWithoutContent,
      id: "aMessageId_P" as NonEmptyString
    }
  ];
  const aMessageList = aSimpleList.map(m => E.right(m));

  beforeEach(() => jest.clearAllMocks());

  it("should respond with a page of messages when given enrichment parameter", async () => {
    const messageIterator = getMockIterator(aMessageList);
    const messageModelMock = getMessageModelMock(messageIterator);

    const getMessagesFunctionSelector = createGetMessagesFunctionSelection(
      false,
      "none",
      [messageModelMock, messageStatusModelMock, blobServiceMock],
      [messageViewModelMock]
    );

    const getMessagesHandler = GetMessagesHandler(
      getMessagesFunctionSelector,
      serviceModelMock,
      aRedisClient,
      aServiceCacheTtl
    );

    const pageSize = 2 as NonNegativeInteger;

    const result = await getMessagesHandler(
      functionsContextMock,
      aFiscalCode,
      O.some(pageSize),
      O.some(true),
      O.none,
      O.none,
      O.none
    );

    expect(result.kind).toBe("IResponseSuccessJson");

    const expectedEnrichedMessage = {
      ...retrievedMessageToPublic(aSimpleList[0]),
      category: { tag: TagEnumBase.GENERIC },
      has_attachments: false,
      message_title: "a subject",
      is_archived: false,
      is_read: false,
      organization_name: aRetrievedService.organizationName,
      service_name: aRetrievedService.serviceName
    };

    if (result.kind === "IResponseSuccessJson") {
      expect(result.value).toEqual({
        items: [
          { ...expectedEnrichedMessage, id: aSimpleList[0].id },
          { ...expectedEnrichedMessage, id: aSimpleList[1].id }
        ],
        prev: aSimpleList[0].id,
        next: aSimpleList[1].id
      });
    }

    expect(messageIterator.next).toHaveBeenCalledTimes(1);
    expect(functionsContextMock.log.error).not.toHaveBeenCalled();
  });

  it("should respond with no messages when archived is requested", async () => {
    const messageIterator = getMockIterator(aMessageList);
    const messageModelMock = getMessageModelMock(messageIterator);

    const getMessagesFunctionSelector = createGetMessagesFunctionSelection(
      false,
      "none",
      [messageModelMock, messageStatusModelMock, blobServiceMock],
      [messageViewModelMock]
    );

    const getMessagesHandler = GetMessagesHandler(
      getMessagesFunctionSelector,
      serviceModelMock,
      aRedisClient,
      aServiceCacheTtl
    );

    const pageSize = 2 as NonNegativeInteger;

    const result = await getMessagesHandler(
      functionsContextMock,
      aFiscalCode,
      O.some(pageSize),
      O.some(true),
      O.some(true),
      O.none,
      O.none
    );

    expect(result.kind).toBe("IResponseSuccessJson");

    if (result.kind === "IResponseSuccessJson") {
      expect(result.value).toEqual({
        items: [],
        prev: undefined,
        next: undefined
      });
    }

    expect(messageIterator.next).toHaveBeenCalledTimes(2);
    expect(functionsContextMock.log.error).not.toHaveBeenCalled();
  });

  it("should respond with archived messages only when archived filter is true", async () => {
    const messageIterator = getMockIterator(aMessageList);
    const messageModelMock = getMessageModelMock(messageIterator);

    mockFindAllVersionsByModelIdIn.mockImplementationOnce((ids: string[]) => {
      return buildIterator(
        RetrievedMessageStatus,
        ids.map((id, index) => ({
          ...aRetrievedMessageStatus,
          messageId: id,
          isArchived: index === 0
        }))
      );
    });

    const getMessagesFunctionSelector = createGetMessagesFunctionSelection(
      false,
      "none",
      [messageModelMock, messageStatusModelMock, blobServiceMock],
      [messageViewModelMock]
    );

    const getMessagesHandler = GetMessagesHandler(
      getMessagesFunctionSelector,
      serviceModelMock,
      aRedisClient,
      aServiceCacheTtl
    );

    const pageSize = 2 as NonNegativeInteger;

    const result = await getMessagesHandler(
      functionsContextMock,
      aFiscalCode,
      O.some(pageSize),
      O.some(true),
      O.some(true),
      O.none,
      O.none
    );

    expect(result.kind).toBe("IResponseSuccessJson");

    const expectedEnrichedMessage = {
      ...retrievedMessageToPublic(aSimpleList[0]),
      category: { tag: TagEnumBase.GENERIC },
      has_attachments: false,
      message_title: "a subject",
      is_archived: true,
      is_read: false,
      organization_name: aRetrievedService.organizationName,
      service_name: aRetrievedService.serviceName
    };

    if (result.kind === "IResponseSuccessJson") {
      expect(result.value).toEqual({
        items: [expectedEnrichedMessage],
        prev: aSimpleList[0].id,
        next: undefined
      });
    }

    expect(messageIterator.next).toHaveBeenCalledTimes(2);
    expect(functionsContextMock.log.error).not.toHaveBeenCalled();
  });

  it("should respond with internal error when messages cannot be enriched with content", async () => {
    const messageIterator = getMockIterator(aMessageList);
    const messageModelMock = getMessageModelMock(messageIterator);

    messageModelMock.getContentFromBlob = jest
      .fn()
      .mockImplementationOnce(() => TE.left(new Error("GENERIC_ERROR")));

    const getMessagesFunctionSelector = createGetMessagesFunctionSelection(
      false,
      "none",
      [messageModelMock, messageStatusModelMock, blobServiceMock],
      [messageViewModelMock]
    );

    const getMessagesHandler = GetMessagesHandler(
      getMessagesFunctionSelector,
      serviceModelMock,
      aRedisClient,
      aServiceCacheTtl
    );

    const pageSize = 2 as NonNegativeInteger;

    const result = await getMessagesHandler(
      functionsContextMock,
      aFiscalCode,
      O.some(pageSize),
      O.some(true),
      O.none,
      O.none,
      O.none
    );

    expect(result.kind).toBe("IResponseErrorInternal");
    expect(messageIterator.next).toHaveBeenCalledTimes(1);
    expect(functionsContextMock.log.error).toHaveBeenCalledTimes(1);
    expect(functionsContextMock.log.error).toHaveBeenCalledWith(
      `Cannot enrich message "${aSimpleList[0].id}" | Error: GENERIC_ERROR`
    );
  });

  it("should respond with internal error when messages cannot be enriched with message status info", async () => {
    const messageIterator = getMockIterator(aMessageList);
    const messageModelMock = getMessageModelMock(messageIterator);

    mockFindAllVersionsByModelIdIn.mockImplementationOnce((ids: string[]) => {
      return buildIterator(
        RetrievedMessageStatus,
        ids.map((id, index) => ({
          ...aRetrievedMessageStatus,
          messageId: id,
          isArchived: index === 0
        })),
        undefined,
        toCosmosErrorResponse("Any message-status error")
      );
    });

    const getMessagesFunctionSelector = createGetMessagesFunctionSelection(
      false,
      "none",
      [messageModelMock, messageStatusModelMock, blobServiceMock],
      [messageViewModelMock]
    );

    const getMessagesHandler = GetMessagesHandler(
      getMessagesFunctionSelector,
      serviceModelMock,
      aRedisClient,
      aServiceCacheTtl
    );

    const pageSize = 2 as NonNegativeInteger;

    const result = await getMessagesHandler(
      functionsContextMock,
      aFiscalCode,
      O.some(pageSize),
      O.some(true),
      O.none,
      O.none,
      O.none
    );

    expect(result.kind).toBe("IResponseErrorInternal");
    expect(messageIterator.next).toHaveBeenCalledTimes(1);
    expect(functionsContextMock.log.error).toHaveBeenCalledTimes(1);
    expect(functionsContextMock.log.error).toHaveBeenCalledWith(
      `Cannot enrich message status | Error: Error retrieving data from cosmos.`
    );
  });
});

describe("GetMessagesHandler |> Message View", () => {
  const aSimpleList = [
    {
      ...aRetrievedMessageView,
      id: "aMessageId_5" as NonEmptyString
    },
    {
      ...aRetrievedMessageView,
      id: "aMessageId_4" as NonEmptyString
    },
    {
      ...aRetrievedMessageView,
      id: "aMessageId_3" as NonEmptyString
    },
    {
      ...aRetrievedMessageView,
      id: "aMessageId_2" as NonEmptyString
    },
    {
      ...aRetrievedMessageView,
      id: "aMessageId_1" as NonEmptyString
    }
  ];

  beforeEach(() => jest.clearAllMocks());

  it("should respond with a page of messages", async () => {
    let iteratorCalls = 0;

    mockQueryPage.mockImplementationOnce(_ => {
      return TE.of(
        buildIterator(RetrievedMessageView, aSimpleList, _ => {
          iteratorCalls++;
        })
      );
    });

    const getMessagesFunctionSelector = createGetMessagesFunctionSelection(
      false,
      "prod",
      [
        {} as MessageModel,
        {} as MessageStatusExtendedQueryModel,
        {} as BlobService
      ],
      [messageViewModelMock]
    );

    const getMessagesHandler = GetMessagesHandler(
      getMessagesFunctionSelector,
      serviceModelMock,
      aRedisClient,
      aServiceCacheTtl
    );

    const pageSize = 2 as NonNegativeInteger;

    const result = await getMessagesHandler(
      functionsContextMock,
      aFiscalCode,
      O.some(pageSize),
      O.some(true),
      O.none,
      O.none,
      O.none
    );

    expect(result.kind).toBe("IResponseSuccessJson");

    const expectedEnrichedMessage = {
      ...toEnrichedMessageWithContent(aSimpleList[0]),
      category: {
        rptId: `${aRetrievedService.organizationFiscalCode}177777777777777777`,
        tag: "PAYMENT"
      },
      organization_name: aRetrievedService.organizationName,
      service_name: aRetrievedService.serviceName
    };

    if (result.kind === "IResponseSuccessJson") {
      expect(result.value).toEqual({
        items: [
          { ...expectedEnrichedMessage, id: aSimpleList[0].id },
          { ...expectedEnrichedMessage, id: aSimpleList[1].id }
        ],
        prev: aSimpleList[0].id,
        next: aSimpleList[1].id
      });
    }

    expect(iteratorCalls).toEqual(1);
    expect(functionsContextMock.log.error).not.toHaveBeenCalled();
  });

  it("should respond with no messages when archived is requested", async () => {
    let iteratorCalls = 0;

    mockQueryPage.mockImplementationOnce(_ => {
      return TE.of(
        buildIterator(RetrievedMessageView, [], _ => {
          iteratorCalls++;
        })
      );
    });

    const getMessagesFunctionSelector = createGetMessagesFunctionSelection(
      false,
      "prod",
      [
        {} as MessageModel,
        {} as MessageStatusExtendedQueryModel,
        {} as BlobService
      ],
      [messageViewModelMock]
    );

    const getMessagesHandler = GetMessagesHandler(
      getMessagesFunctionSelector,
      serviceModelMock,
      aRedisClient,
      aServiceCacheTtl
    );

    const pageSize = 2 as NonNegativeInteger;

    const result = await getMessagesHandler(
      functionsContextMock,
      aFiscalCode,
      O.some(pageSize),
      O.some(true),
      O.some(true),
      O.none,
      O.none
    );

    expect(result.kind).toBe("IResponseSuccessJson");

    if (result.kind === "IResponseSuccessJson") {
      expect(result.value).toEqual({
        items: [],
        prev: undefined,
        next: undefined
      });
    }

    expect(iteratorCalls).toEqual(0);
    expect(functionsContextMock.log.error).not.toHaveBeenCalled();
  });

  it("should respond with internal error when messages cannot be enriched with service info", async () => {
    let iteratorCalls = 0;

    mockQueryPage.mockImplementationOnce(_ => {
      return TE.of(
        buildIterator(RetrievedMessageView, aSimpleList, _ => {
          iteratorCalls++;
        })
      );
    });

    mockFindLastVersionByModelId.mockImplementationOnce(() =>
      TE.left(toCosmosErrorResponse("Any error message"))
    );

    const getMessagesFunctionSelector = createGetMessagesFunctionSelection(
      false,
      "prod",
      [
        {} as MessageModel,
        {} as MessageStatusExtendedQueryModel,
        {} as BlobService
      ],
      [messageViewModelMock]
    );

    const getMessagesHandler = GetMessagesHandler(
      getMessagesFunctionSelector,
      serviceModelMock,
      aRedisClient,
      aServiceCacheTtl
    );

    const pageSize = 2 as NonNegativeInteger;

    const result = await getMessagesHandler(
      functionsContextMock,
      aFiscalCode,
      O.some(pageSize),
      O.some(true),
      O.some(true),
      O.none,
      O.none
    );

    expect(result.kind).toBe("IResponseErrorInternal");

    expect(iteratorCalls).toEqual(1);
    expect(functionsContextMock.log.error).toHaveBeenCalledTimes(1);
    expect(functionsContextMock.log.error).toHaveBeenCalledWith(
      `Cannot enrich service data | Error: COSMOS_ERROR_RESPONSE, ServiceId=${aSimpleList[0].senderServiceId}`
    );
  });

  it("should respond with query error if it cannot build queryPage iterator", async () => {
    mockQueryPage.mockImplementationOnce(_ =>
      TE.left(toCosmosErrorResponse("Cosmos Error"))
    );

    const getMessagesFunctionSelector = createGetMessagesFunctionSelection(
      false,
      "prod",
      [
        {} as MessageModel,
        {} as MessageStatusExtendedQueryModel,
        {} as BlobService
      ],
      [messageViewModelMock]
    );

    const getMessagesHandler = GetMessagesHandler(
      getMessagesFunctionSelector,
      serviceModelMock,
      aRedisClient,
      aServiceCacheTtl
    );

    const result = await getMessagesHandler(
      functionsContextMock,
      aFiscalCode,
      O.none,
      O.none,
      O.none,
      O.none,
      O.none
    );
    expect(result.kind).toBe("IResponseErrorQuery");
    expect(functionsContextMock.log.error).toHaveBeenCalledWith(
      "getMessagesFromView|Error building queryPage iterator"
    );
  });

  it("should respond with query error if it cannot retrieve messages", async () => {
    mockQueryPage.mockImplementationOnce(_ => {
      return TE.of(
        buildIterator(
          RetrievedMessageView,
          aSimpleList,
          _ => {},
          Error("IterationError")
        )
      );
    });

    const getMessagesFunctionSelector = createGetMessagesFunctionSelection(
      false,
      "prod",
      [
        {} as MessageModel,
        {} as MessageStatusExtendedQueryModel,
        {} as BlobService
      ],
      [messageViewModelMock]
    );

    const getMessagesHandler = GetMessagesHandler(
      getMessagesFunctionSelector,
      serviceModelMock,
      aRedisClient,
      aServiceCacheTtl
    );

    const result = await getMessagesHandler(
      functionsContextMock,
      aFiscalCode,
      O.none,
      O.none,
      O.none,
      O.none,
      O.none
    );
    expect(result.kind).toBe("IResponseErrorQuery");
    expect(functionsContextMock.log.error).toHaveBeenCalledWith(
      "getMessagesFromView|Error retrieving page data from cosmos|IterationError"
    );
  });
});
