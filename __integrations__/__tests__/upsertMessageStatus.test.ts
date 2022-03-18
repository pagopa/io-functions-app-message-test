/* eslint-disable @typescript-eslint/no-use-before-define */
/* eslint-disable sort-keys */
import { exit } from "process";

import { CosmosClient, Database } from "@azure/cosmos";
import { createBlobService } from "azure-storage";

import * as TE from "fp-ts/TaskEither";
import * as E from "fp-ts/Either";
import * as O from "fp-ts/Option";
import { pipe } from "fp-ts/lib/function";

import {
  createCosmosDbAndCollections,
  fillMessages,
  fillMessagesStatus,
  fillServices
} from "../__mocks__/fixtures";

import {
  aFiscalCodeWithMessages,
  aMessage,
  messagesList,
  messageStatusList
} from "../__mocks__/mock.messages";
import { serviceList } from "../__mocks__/mock.services";
import { createBlobs } from "../__mocks__/utils/azure_storage";
import { getNodeFetch } from "../utils/fetch";
import { upsertMessageStatus } from "../utils/client";
import { log } from "../utils/logger";

import {
  WAIT_MS,
  SHOW_LOGS,
  COSMOSDB_URI,
  COSMOSDB_KEY,
  COSMOSDB_NAME,
  QueueStorageConnection,
  MESSAGE_CONTAINER_NAME
} from "../env";
import { NonEmptyString } from "@pagopa/ts-commons/lib/strings";
import {
  MessageStatus,
  MessageStatusModel
} from "@pagopa/io-functions-commons/dist/src/models/message_status";
import { MessageStatusChange } from "@pagopa/io-functions-commons/dist/generated/definitions/MessageStatusChange";
import { randomInt } from "crypto";
import { NonNegativeInteger } from "@pagopa/ts-commons/lib/numbers";

// --------------------------
// Variables
// --------------------------

const aReadingStatusChange = {
  change_type: "reading",
  is_read: true
} as MessageStatusChange;

const anArchivingStatusChange = {
  change_type: "archiving",
  is_archived: true
} as MessageStatusChange;

const aBulkStatusChange = {
  change_type: "bulk",
  is_read: true,
  is_archived: true
} as MessageStatusChange;

// --------------------------

const MAX_ATTEMPT = 50;

jest.setTimeout(WAIT_MS * MAX_ATTEMPT);

const baseUrl = "http://function:7071/api/v1";
const fetch = getNodeFetch();

// ----------------
// Setup dbs
// ----------------

const blobService = createBlobService(QueueStorageConnection);

const cosmosClient = new CosmosClient({
  endpoint: COSMOSDB_URI,
  key: COSMOSDB_KEY
});

// eslint-disable-next-line functional/no-let
let database: Database;

// Wait some time
beforeAll(async () => {
  database = await pipe(
    createCosmosDbAndCollections(cosmosClient, COSMOSDB_NAME),
    TE.getOrElse(() => {
      throw Error("Cannot create db");
    })
  )();

  await pipe(
    createBlobs(blobService, [MESSAGE_CONTAINER_NAME]),
    TE.getOrElse(() => {
      throw Error("Cannot create azure storage");
    })
  )();

  await fillMessages(database, blobService, messagesList);
  await fillMessagesStatus(database, messageStatusList);
  await fillServices(database, serviceList);

  await waitFunctionToSetup();
});

beforeEach(() => {
  jest.clearAllMocks();
});

// -------------------------
// Tests
// -------------------------

describe("Upsert Message Status |> Success Results |> Existing Message Status", () => {
  it("should return a new version of message-status when reading status is applied", async () => {
    // Always use a diffent messageId, since message-status collection is not refreshed
    const aMessageId = messagesList[0].id;

    const maybeCurrentStatus = await getMessageStatusList(aMessageId);
    if (O.isNone(maybeCurrentStatus)) {
      fail("Current Message Status not found");
    }
    const currentStatus = maybeCurrentStatus.value;

    const response = await upsertMessageStatus(fetch, baseUrl)(
      aFiscalCodeWithMessages,
      aMessageId,
      aReadingStatusChange
    );
    expect(response.status).toEqual(200);
    const body = (await response.json()) as MessageStatus;

    console.log(body);

    const maybeNewStatus = await getMessageStatusList(aMessageId);
    if (O.isNone(maybeNewStatus)) {
      fail("New Message Status not found");
    }
    const newStatus = maybeNewStatus.value;

    expect(newStatus).toMatchObject(
      expect.objectContaining({
        version: currentStatus.version + 1,
        isArchived: currentStatus.isArchived,
        isRead: !currentStatus.isRead
      })
    );
  });

  it("should return a new version of message-status when archiving status is applied", async () => {
    // Always use a diffent messageId, since message-status collection is not refreshed
    const aMessageId = messagesList[1].id;

    const maybeCurrentStatus = await getMessageStatusList(aMessageId);
    if (O.isNone(maybeCurrentStatus)) {
      fail("Current Message Status not found");
    }
    const currentStatus = maybeCurrentStatus.value;

    const response = await upsertMessageStatus(fetch, baseUrl)(
      aFiscalCodeWithMessages,
      aMessageId,
      anArchivingStatusChange
    );
    expect(response.status).toEqual(200);
    const body = (await response.json()) as MessageStatus;

    console.log(body);

    const maybeNewStatus = await getMessageStatusList(aMessageId);
    if (O.isNone(maybeNewStatus)) {
      fail("New Message Status not found");
    }
    const newStatus = maybeNewStatus.value;

    expect(newStatus).toMatchObject(
      expect.objectContaining({
        version: currentStatus.version + 1,
        isArchived: !currentStatus.isArchived,
        isRead: currentStatus.isRead
      })
    );
  });

  it("should return a new version of message-status when bulk status is applied", async () => {
    // Always use a diffent messageId, since message-status collection is not refreshed
    const aMessageId = messagesList[2].id;

    const maybeCurrentStatus = await getMessageStatusList(aMessageId);
    if (O.isNone(maybeCurrentStatus)) {
      fail("Current Message Status not found");
    }
    const currentStatus = maybeCurrentStatus.value;

    const response = await upsertMessageStatus(fetch, baseUrl)(
      aFiscalCodeWithMessages,
      aMessageId,
      aBulkStatusChange
    );
    expect(response.status).toEqual(200);
    const body = (await response.json()) as MessageStatus;

    console.log(body);

    const maybeNewStatus = await getMessageStatusList(aMessageId);
    if (O.isNone(maybeNewStatus)) {
      fail("New Message Status not found");
    }
    const newStatus = maybeNewStatus.value;

    expect(newStatus).toMatchObject(
      expect.objectContaining({
        version: currentStatus.version + 1,
        isArchived: !currentStatus.isArchived,
        isRead: !currentStatus.isRead
      })
    );
  });
});

describe("Upsert Message Status |> Success Results |> Non Existing Message Status", () => {
  it("should return a new version of message-status", async () => {
    // Add new message without any message status
    const aMessageWithoutMessageStatus = {
      ...aMessage,
      id: `${aMessage.id}_nostatus_${randomInt(1000000)}` as NonEmptyString,
      indexedId: `${aMessage.id}_nostatus_${randomInt(
        1000000
      )}` as NonEmptyString
    };
    await fillMessages(database, blobService, [aMessageWithoutMessageStatus]);

    const aMessageId = aMessageWithoutMessageStatus.id;

    const maybeCurrentStatus = await getMessageStatusList(aMessageId);
    if (O.isSome(maybeCurrentStatus)) {
      fail("Message Status found, but not expected");
    }

    const response = await upsertMessageStatus(fetch, baseUrl)(
      aFiscalCodeWithMessages,
      aMessageId,
      aReadingStatusChange
    );
    expect(response.status).toEqual(200);
    const body = (await response.json()) as MessageStatus;

    console.log(body);

    const maybeNewStatus = await getMessageStatusList(aMessageId);
    if (O.isNone(maybeNewStatus)) {
      fail("New Message Status not found");
    }
    const newStatus = maybeNewStatus.value;

    expect(newStatus).toMatchObject(
      expect.objectContaining({
        version: 0,
        isArchived: false,
        isRead: true
      })
    );
  });
});

// -----------------------
// utils
// -----------------------

const delay = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

const waitFunctionToSetup = async (): Promise<void> => {
  log("ENV: ", COSMOSDB_URI, WAIT_MS, SHOW_LOGS);
  // eslint-disable-next-line functional/no-let
  let i = 0;
  while (i < MAX_ATTEMPT) {
    log("Waiting the function to setup..");
    try {
      await fetch(baseUrl + "/info");
      break;
    } catch (e) {
      log("Waiting the function to setup..");
      await delay(WAIT_MS);
      i++;
    }
  }
  if (i >= MAX_ATTEMPT) {
    log("Function unable to setup in time");
    exit(1);
  }
};

const getMessageStatusList = async (messageId: NonEmptyString) => {
  const model = new MessageStatusModel(database.container("message-status"));

  return pipe(
    model.findLastVersionByModelId([messageId]),
    TE.getOrElse(() => {
      fail("Current MessageStatus not found");
    }),
    x => x
  )();
};
