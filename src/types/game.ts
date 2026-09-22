export interface PlayerState {
  name: string;
  level: number;
  exp: number;
  maxExp: number;
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  gold: number;
  currentMapId: string;
  inventory: { itemId: string; name: string; quantity: number }[];
  equipped: {
    weapon?: string;
    armor?: string;
  };
}

export interface StoryMessage {
  id: string;
  sender: 'ai' | 'user' | 'system';
  text: string;
  options?: string[];
  timestamp: string;
}

export interface AIResponsePayload {
  storyText: string;
  suggestedActions: string[];
  stateChanges?: {
    hpChange?: number;
    mpChange?: number;
    expChange?: number;
    goldChange?: number;
    addItems?: { name: string; quantity: number }[];
    removeItems?: { name: string; quantity: number }[];
    newLocationId?: string;
  };
}