import { flow, pipe } from "fp-ts/lib/function";
import * as TE from "fp-ts/lib/TaskEither";
import * as RA from "fp-ts/lib/ReadonlyArray";
import * as O from "fp-ts/lib/Option";

import { flattenAsyncIterable } from "@pagopa/io-functions-commons/dist/src/utils/async";

import { defaultPageSize } from "@pagopa/io-functions-commons/dist/src/models/message";

import { toPageResults } from "@pagopa/io-functions-commons/dist/src/utils/paging";
import {
  CosmosErrors,
  toCosmosErrorResponse
} from "@pagopa/io-functions-commons/dist/src/utils/cosmosdb_model";
import { RetrievedMessageView } from "@pagopa/io-functions-commons/dist/src/models/message_view";
import { NonEmptyString } from "@pagopa/ts-commons/lib/strings";
import { TagEnum } from "@pagopa/io-functions-commons/dist/generated/definitions/MessageCategoryBase";
import { TagEnum as TagEnumPayment } from "@pagopa/io-functions-commons/dist/generated/definitions/MessageCategoryPayment";
import { RedisClient } from "redis";
import { NonNegativeInteger } from "@pagopa/ts-commons/lib/numbers";
import * as AI from "../../utils/AsyncIterableTask";

import { MessageViewExtendedQueryModel } from "../../model/message_view_query";
import {
  ThirdPartyDataWithCategoryFetcher,
  computeFlagFromHasPrecondition
} from "../../utils/messages";
import { EnrichedMessageWithContent, InternalMessageCategory } from "./models";
import { IGetMessagesFunction, IPageResult } from "./getMessages.selector";
import { RemoteContentConfigurationModel } from "@pagopa/io-functions-commons/dist/src/models/remote_content_configuration";
import { getOrCacheRemoteServiceConfig } from "../../utils/remoteContentConfig";

export const getHasPreconditionFlagForMessagesFromView = (
  retrievedMessagesFromView: ReadonlyArray<RetrievedMessageView>,
  categoryFetcher: ThirdPartyDataWithCategoryFetcher,
  redisClient: RedisClient,
  remoteContentConfigurationModel: RemoteContentConfigurationModel,
  remoteContentConfigurationTtl: NonNegativeInteger
  // eslint-disable-next-line max-params
): TE.TaskEither<Error, ReadonlyArray<EnrichedMessageWithContent>> =>
  pipe(
    retrievedMessagesFromView,
    RA.map(message => {
      return pipe(
        O.fromNullable(
          message.components.thirdParty?.has
            ? message.components.thirdParty.has_precondition
            : undefined
        ),
        O.fold(
          () =>
            pipe(
              getOrCacheRemoteServiceConfig(
                redisClient,
                remoteContentConfigurationModel,
                remoteContentConfigurationTtl,
                message.senderServiceId
              ),
              TE.map(serviceConfig => serviceConfig.hasPrecondition)
            ),
          hasPrecondition => TE.of(hasPrecondition)
        ),
        TE.map(hasPrecondition =>
          pipe(
            computeFlagFromHasPrecondition(
              hasPrecondition,
              message.status.read
            ),
            hasPrecondition =>
              toEnrichedMessageWithContent(categoryFetcher)(
                message,
                hasPrecondition
              )
          )
        )
      );
    }),
    TE.sequenceArray
  );

export const getMessagesFromView = (
  messageViewModel: MessageViewExtendedQueryModel,
  remoteContentConfigurationModel: RemoteContentConfigurationModel,
  redisClient: RedisClient,
  remoteContentConfigurationTtl: NonNegativeInteger,
  categoryFetcher: ThirdPartyDataWithCategoryFetcher
): IGetMessagesFunction => ({
  context,
  fiscalCode,
  shouldGetArchivedMessages,
  maximumId,
  minimumId,
  pageSize = defaultPageSize
}): TE.TaskEither<
  CosmosErrors | Error,
  IPageResult<EnrichedMessageWithContent>
> =>
  pipe(
    messageViewModel.queryPage(fiscalCode, maximumId, minimumId, pageSize),
    TE.mapLeft(err => {
      context.log.error(
        `getMessagesFromView|Error building queryPage iterator`
      );
      return err;
    }),
    TE.chainW(
      flow(
        AI.fromAsyncIterable,
        AI.map(RA.rights),
        AI.map(
          RA.filter(
            message => message.status.archived === shouldGetArchivedMessages
          )
        ),
        AI.mapIterable(flattenAsyncIterable),
        AI.toPageArray(toCosmosErrorResponse, pageSize),
        TE.map(({ hasMoreResults, results }) =>
          toPageResults(results, hasMoreResults)
        ),
        TE.chainW(pageResult =>
          pipe(
            getHasPreconditionFlagForMessagesFromView(
              pageResult.items as ReadonlyArray<RetrievedMessageView>,
              categoryFetcher,
              redisClient,
              remoteContentConfigurationModel,
              remoteContentConfigurationTtl
            ),
            TE.map(items => ({
              ...pageResult,
              items: items 
            }))
          )
        ),
        TE.mapLeft(err => {
          context.log.error(
            `getMessagesFromView|Error retrieving page data from cosmos|${JSON.stringify(err)}`
          );
          return err;
        })
      )
    )
  );

/**
 * Map `RetrievedMessageView` to `EnrichedMessageWithContent`
 */
export const toEnrichedMessageWithContent = (
  categoryFetcher: ThirdPartyDataWithCategoryFetcher
) => (
  item: RetrievedMessageView,
  hasPrecondition: boolean
): EnrichedMessageWithContent => ({
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  category: toCategory(categoryFetcher)(item),
  created_at: item.createdAt,
  fiscal_code: item.fiscalCode,
  has_attachments: item.components.thirdParty.has
    ? item.components.thirdParty.has_attachments
    : false,
  has_remote_content: item.components.thirdParty.has
    ? item.components.thirdParty.has_remote_content
    : false,
  has_precondition: hasPrecondition ?? false,
  id: item.id,
  is_archived: item.status.archived,
  is_read: item.status.read,
  message_title: item.messageTitle,
  sender_service_id: item.senderServiceId,
  time_to_live: item.timeToLive
});

/**
 * Map components to `InternalMessageCategory`
 */
const toCategory = (categoryFetcher: ThirdPartyDataWithCategoryFetcher) => ({
  components,
  senderServiceId
}: RetrievedMessageView): InternalMessageCategory =>
  components.euCovidCert.has
    ? { tag: TagEnum.EU_COVID_CERT }
    : components.legalData.has
    ? { tag: TagEnum.LEGAL_MESSAGE }
    : components.thirdParty.has
    ? {
        has_attachments: components.thirdParty.has_attachments,
        id: components.thirdParty.id,
        original_receipt_date: components.thirdParty.original_receipt_date,
        original_sender: components.thirdParty.original_sender,
        summary: components.thirdParty.summary,
        tag: categoryFetcher(senderServiceId).category
      }
    : components.payment.has
    ? {
        // Ignore ts error since we've already checked payment.has to be true
        noticeNumber: (components.payment
          .notice_number as unknown) as NonEmptyString,
        tag: TagEnumPayment.PAYMENT
      }
    : { tag: TagEnum.GENERIC };
