import { Server } from "@server";
import path from "path";
import fs from "fs";
import { FileSystem } from "@server/fileSystem";
import { isMinBigSur, isMinSequoia } from "@server/env";
import { checkPrivateApiStatus, waitMs } from "@server/helpers/utils";
import { quitFindMyFriends, startFindMyFriends, showFindMyFriends, hideFindMyFriends } from "../apple/scripts";
import { FindMyDevice, FindMyItem, FindMyLocationItem, FindMyResolvedHandle } from "@server/api/lib/findmy/types";
import { transformFindMyItemToDevice } from "@server/api/lib/findmy/utils";

export class FindMyInterface {
    static async getFriends() {
        return Server().findMyCache.getAll();
    }

    private static digitsOnly(address: string): string {
        return String(address ?? "").replace(/\D/g, "");
    }

    private static addressVariants(address: string): string[] {
        const variants = new Set<string>();
        const clean = String(address ?? "").trim();
        if (!clean) return [];

        variants.add(clean);
        variants.add(clean.toLowerCase());

        const digits = this.digitsOnly(clean);
        if (digits.length >= 7) {
            variants.add(digits);
            variants.add(`+${digits}`);
            if (digits.length === 10) variants.add(`+1${digits}`);
            if (digits.length === 11 && digits.startsWith("1")) variants.add(`+${digits}`);
        }

        return [...variants].filter(Boolean);
    }

    private static isPhoneAddress(address: string): boolean {
        return !String(address ?? "").includes("@") && this.digitsOnly(address).length >= 7;
    }

    private static async getDirectMessagesChatGuid(address: string): Promise<string | null> {
        for (const variant of this.addressVariants(address)) {
            for (const guid of [`any;-;${variant}`, `iMessage;-;${variant}`, `SMS;-;${variant}`]) {
                const [chats] = await Server().iMessageRepo.getChats({
                    chatGuid: guid,
                    withParticipants: false,
                    limit: 1
                });

                if (chats?.[0]?.guid) return chats[0].guid;
            }
        }

        return null;
    }

    private static async getMessagesHandleMatch(address: string): Promise<{ handle: string | null; chatGuid: string | null; exists: boolean }> {
        const directChatGuid = await this.getDirectMessagesChatGuid(address);
        if (directChatGuid) return { handle: address, chatGuid: directChatGuid, exists: true };

        for (const variant of this.addressVariants(address)) {
            const [handles] = await Server().iMessageRepo.getHandles({ address: variant, limit: 5 });
            for (const handle of handles ?? []) {
                const chatGuid = await this.getDirectMessagesChatGuid(handle.id);
                return { handle: handle.id, chatGuid, exists: true };
            }
        }

        return { handle: null, chatGuid: null, exists: false };
    }

    private static candidateScore(inputHandle: string, candidate: FindMyResolvedHandle, match: { chatGuid: string | null; exists: boolean }): number {
        const address = candidate?.address ?? "";
        const inputNormalized = inputHandle.toLowerCase();
        const addressNormalized = address.toLowerCase();
        const isInput = inputNormalized === addressNormalized;
        const isPhone = this.isPhoneAddress(address);
        const sources = candidate?.sources ?? [];
        const hasAliasSignal = sources.some(source => !["matched_handle", "matched_handle.person"].includes(source));
        const hasContactSignal = !!(candidate?.contact_id || candidate?.cn_contact_id || candidate?.person_centric_id);

        let score = 0;
        if (match.chatGuid) score += 100;
        if (match.exists) score += 40;
        if (isPhone) score += 25;
        if (!isInput) score += 20;
        if (hasAliasSignal) score += 20;
        if (hasContactSignal) score += 10;
        if (candidate?.service === "iMessage") score += 5;

        return score;
    }

    private static async selectPreferredMessagesHandle(inputHandle: string, candidates: FindMyResolvedHandle[]) {
        let best: { handle: string | null; chatGuid: string | null; confidence: FindMyLocationItem["handle_resolution_confidence"]; score: number } = {
            handle: null,
            chatGuid: null,
            confidence: "none",
            score: -1
        };

        for (const candidate of candidates) {
            if (!candidate?.address) continue;

            const match = await this.getMessagesHandleMatch(candidate.address);
            const score = this.candidateScore(inputHandle, candidate, match);
            if (score <= best.score) continue;

            const isInput = candidate.address.toLowerCase() === inputHandle.toLowerCase();
            const confidence = match.chatGuid ? "messages_chat" : (isInput ? "exact" : "imcore");
            best = {
                handle: match.handle ?? candidate.address,
                chatGuid: match.chatGuid,
                confidence,
                score
            };
        }

        if (best.score < 40) {
            return { handle: null as string | null, chatGuid: null as string | null, confidence: "none" as const };
        }

        return best;
    }

    static async enrichFriendHandles(locations: FindMyLocationItem[]): Promise<FindMyLocationItem[]> {
        if (!Array.isArray(locations) || locations.length === 0) return locations ?? [];

        const handles = [...new Set(locations.map(item => item?.handle).filter((handle): handle is string => !!handle))];
        if (handles.length === 0) return locations;

        let resolutions: any[] = [];
        try {
            const result = await Server().privateApi.handle.resolveAliases(handles);
            resolutions = result?.data?.resolutions ?? [];
        } catch (ex: any) {
            Server().logger.debug(`Failed to resolve Find My friend handles: ${ex?.message ?? String(ex)}`);
            return locations;
        }

        const resolutionMap = new Map<string, any>();
        for (const resolution of resolutions) {
            if (resolution?.input) resolutionMap.set(String(resolution.input).toLowerCase(), resolution);
        }

        const enriched: FindMyLocationItem[] = [];
        for (const item of locations) {
            const handle = item?.handle;
            if (!handle) {
                enriched.push(item);
                continue;
            }

            const resolution = resolutionMap.get(handle.toLowerCase());
            const resolvedHandles = (resolution?.candidates ?? []) as FindMyResolvedHandle[];
            const preferred = await this.selectPreferredMessagesHandle(handle, resolvedHandles);

            enriched.push({
                ...item,
                resolved_handles: resolvedHandles,
                preferred_messages_handle: preferred.handle,
                preferred_messages_chat_guid: preferred.chatGuid,
                handle_resolution_confidence: preferred.confidence ?? resolution?.confidence ?? "none"
            });
        }

        return enriched;
    }

    static async getDevices(): Promise<Array<FindMyDevice> | null> {
        if (isMinSequoia) {
            Server().logger.debug('Cannot fetch FindMy devices on macOS Sequoia or later.');
            return null;
        }

        try {
            const [devices, items] = await Promise.all([
                FindMyInterface.readDataFile("Devices"),
                FindMyInterface.readDataFile("Items")
            ]);

            // Return null if neither of the files exist
            if (devices == null && items == null) return null;

            // Get any items with a group identifier
            const itemsWithGroup = items.filter(item => item.groupIdentifier);
            if (itemsWithGroup.length > 0) {
                try {
                    const itemGroups = await FindMyInterface.readItemGroups();
                    if (itemGroups) {
                        // Create a map of group IDs to group names
                        const groupMap = itemGroups.reduce((acc, group) => {
                            acc[group.identifier] = group.name;
                            return acc;
                        }, {} as Record<string, string>);

                        // Iterate over the items and add the group name
                        for (const item of items) {
                            if (item.groupIdentifier && groupMap[item.groupIdentifier]) {
                                item.groupName = groupMap[item.groupIdentifier];
                            }
                        }
                    }
                } catch (ex: any) {
                    Server().logger.debug('An error occurred while reading FindMy ItemGroups cache file.');
                    Server().logger.debug(String(ex));
                }
            }

            // Transform the items to match the same shape as devices
            const transformedItems = (items ?? []).map(transformFindMyItemToDevice);

            return [...(devices ?? []), ...transformedItems];
        } catch (ex: any) {
            Server().logger.debug('An error occurred while reading FindMy Device cache files.');
            Server().logger.debug(String(ex));
            return null;
        }
    }

    static async refreshDevices(): Promise<Array<FindMyDevice> | null> {
        // Can't use the Private API to refresh devices yet
        await this.refreshLocationsAccessibility();
        return await this.getDevices();
    }

    static async refreshFriends(openFindMyApp = true): Promise<FindMyLocationItem[]> {
        const papiEnabled = Server().repo.getConfig("enable_private_api") as boolean;
        if (papiEnabled && isMinBigSur) {
            checkPrivateApiStatus();
            const result = await Server().privateApi.findmy.refreshFriends();
            const refreshLocations = result?.data?.locations ?? (result as any)?.locations ?? [];
            const enrichedLocations = await this.enrichFriendHandles(refreshLocations);

            // Save the data to the cache
            // The cache will handle properly updating the data.
            Server().findMyCache.addAll(enrichedLocations);
        }

        // No matter what, open the Find My app.
        // Don't await because it should update in the background.
        // Location updates get emitted as an event as they come in.
        if (openFindMyApp) {
            this.refreshLocationsAccessibility();
        }

        return Server().findMyCache.getAll();
    }

    static async refreshLocationsAccessibility() {
        await FileSystem.executeAppleScript(quitFindMyFriends());
        await waitMs(3000);

        // Make sure the Find My app is open.
        // Give it 5 seconds to open
        await FileSystem.executeAppleScript(startFindMyFriends());
        await waitMs(5000);

        // Bring the Find My app to the foreground so it refreshes the devices
        // Give it 15 seconods to refresh
        await FileSystem.executeAppleScript(showFindMyFriends());
        await waitMs(15000);

        // Re-hide the Find My App
        await FileSystem.executeAppleScript(hideFindMyFriends());
    }

    static async readItemGroups(): Promise<Array<any>> {
        const itemGroupsPath = path.join(FileSystem.findMyDir, "ItemGroups.data");
        if (!fs.existsSync(itemGroupsPath)) return [];

        return new Promise((resolve, reject) => {
            fs.readFile(itemGroupsPath, { encoding: "utf-8" }, (err, data) => {
                // Couldn't read the file
                if (err) return resolve(null);

                try {
                    const parsedData = JSON.parse(data.toString());
                    if (Array.isArray(parsedData)) {
                        return resolve(parsedData);
                    } else {
                        reject(new Error("Failed to read FindMy ItemGroups cache file! It is not an array!"));
                    }
                } catch {
                    reject(new Error("Failed to read FindMy ItemGroups cache file! It is not in the correct format!"));
                }
            });
        });
    }

    private static readDataFile<T extends "Devices" | "Items">(
        type: T
    ): Promise<Array<T extends "Devices" ? FindMyDevice : FindMyItem> | null> {
        const devicesPath = path.join(FileSystem.findMyDir, `${type}.data`);
        return new Promise((resolve, reject) => {
            fs.readFile(devicesPath, { encoding: "utf-8" }, (err, data) => {
                // Couldn't read the file
                if (err) return resolve(null);

                try {
                    const parsedData = JSON.parse(data.toString());
                    if (Array.isArray(parsedData)) {
                        return resolve(parsedData);
                    } else {
                        reject(new Error(`Failed to read FindMy ${type} cache file! It is not an array!`));
                    }
                } catch {
                    reject(new Error(`Failed to read FindMy ${type} cache file! It is not in the correct format!`));
                }
            });
        });
    }
}
