import { Server } from "@server";
import {
    TransactionPromise,
    TransactionResult,
    TransactionType
} from "@server/managers/transactionManager/transactionPromise";
import { PrivateApiAction } from ".";
import type { MessageProtocol } from "@server/api/types";

export class PrivateApiAttachment extends PrivateApiAction {
    tag = "PrivateApiAttachment";

    async send({
        chatGuid,
        addresses = null,
        service = null,
        filePath,
        isAudioMessage = false,
        attributedBody = null,
        subject = null,
        effectId = null,
        selectedMessageGuid = null,
        partIndex = 0
    }: {
        chatGuid?: string;
        addresses?: string[] | null;
        service?: MessageProtocol | null;
        filePath: string;
        isAudioMessage?: boolean;
        attributedBody?: Record<string, any> | null;
        subject?: string;
        effectId?: string;
        selectedMessageGuid?: string;
        partIndex?: number;
    }): Promise<TransactionResult> {
        const action = "send-attachment";
        this.throwForNoMissingFields(action, [chatGuid || addresses, filePath]);
        const request = new TransactionPromise(TransactionType.ATTACHMENT);
        return this.sendApiMessage(
            action,
            {
                chatGuid,
                addresses,
                service,
                filePath,
                isAudioMessage: isAudioMessage ? 1 : 0,
                attributedBody,
                subject,
                effectId,
                selectedMessageGuid,
                partIndex
            },
            request
        );
    }

    async downloadPurged(guid: string): Promise<TransactionResult> {
        const action = "download-purged-attachment";
        this.throwForNoMissingFields(action, [guid]);
        return this.sendApiMessage(action, { attachmentGuid: guid });
    }
}
