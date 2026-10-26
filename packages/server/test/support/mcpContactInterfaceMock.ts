let contacts: any[] = [];

export function setMcpTestContacts(values: any[]): void {
    contacts = values;
}

export class ContactInterface {
    static async getAllContacts(): Promise<any[]> {
        return contacts;
    }
}
