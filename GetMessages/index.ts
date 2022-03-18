import { Context } from "@azure/functions";

import * as express from "express";

import { secureExpressApp } from "@pagopa/io-functions-commons/dist/src/utils/express";
import { setAppContext } from "@pagopa/io-functions-commons/dist/src/utils/middlewares/context_middleware";

import {
  MESSAGE_COLLECTION_NAME,
  MessageModel
} from "@pagopa/io-functions-commons/dist/src/models/message";
import { MESSAGE_STATUS_COLLECTION_NAME } from "@pagopa/io-functions-commons/dist/src/models/message_status";

import createAzureFunctionHandler from "@pagopa/express-azure-functions/dist/src/createAzureFunctionsHandler";

import {
  ServiceModel,
  SERVICE_COLLECTION_NAME
} from "@pagopa/io-functions-commons/dist/src/models/service";
import { createBlobService } from "azure-storage";
import { cosmosdbInstance } from "../utils/cosmosdb";
import { getConfigOrThrow } from "../utils/config";
import { REDIS_CLIENT } from "../utils/redis";
import { MessageStatusExtendedQueryModel } from "../model/message_status_query";
import { GetMessages } from "./handler";

// Setup Express
const app = express();
secureExpressApp(app);

const config = getConfigOrThrow();

const messageModel = new MessageModel(
  cosmosdbInstance.container(MESSAGE_COLLECTION_NAME),
  config.MESSAGE_CONTAINER_NAME
);
const messageStatusModel = new MessageStatusExtendedQueryModel(
  cosmosdbInstance.container(MESSAGE_STATUS_COLLECTION_NAME)
);

const serviceModel = new ServiceModel(
  cosmosdbInstance.container(SERVICE_COLLECTION_NAME)
);

const blobService = createBlobService(config.QueueStorageConnection);

app.get(
  "/api/v1/messages/:fiscalcode",
  GetMessages(
    messageModel,
    messageStatusModel,
    serviceModel,
    blobService,
    REDIS_CLIENT,
    config.SERVICE_CACHE_TTL_DURATION
  )
);

const azureFunctionHandler = createAzureFunctionHandler(app);

// Binds the express app to an Azure Function handler
// eslint-disable-next-line prefer-arrow/prefer-arrow-functions
function httpStart(context: Context): void {
  setAppContext(app, context);
  azureFunctionHandler(context);
}

export default httpStart;
