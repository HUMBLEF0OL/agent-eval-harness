export interface Profile {
  name: string;
}

export interface User {
  profile?: Profile;
}

export function displayName(user: User): string {
  return user.profile!.name;
}
