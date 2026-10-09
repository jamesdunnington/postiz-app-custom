import { IsOptional, ValidateIf, IsUrl, IsString } from 'class-validator';

// Unofficial IDs, collected from Publer's docs and from Facebook's web composer.
// Meta does not document them, so some may stop working without notice.
export const facebookBackgroundPresets = [
  { label: 'Red / blue gradient', value: '249307305544279' },
  { label: 'Orange / purple gradient', value: '303063890126415' },
  { label: 'Dark orange-red gradient', value: '901751159967576' },
  { label: 'Blue / white gradient', value: '1679248482160767' },
  { label: 'Solid purple', value: '106018623298955' },
  { label: 'Solid red', value: '1903718606535395' },
  { label: 'Solid teal', value: '301029513638534' },
  { label: 'Solid black', value: '1881421442117417' },
  { label: 'Fire', value: '200521337465306' },
  { label: 'Soccer green', value: '127541261450947' },
  { label: 'Blue sky', value: '143093446467972' },
  { label: 'Blue, green and aqua', value: '931584293685988' },
  { label: '3D hearts', value: '191761991491375' },
];

export class FacebookDto {
  @IsOptional()
  @ValidateIf(p => p.url)
  @IsUrl()
  url?: string;

  // Colored background for text-only Page posts (max 130 characters).
  @IsOptional()
  @IsString()
  text_format_preset_id?: string;
}
