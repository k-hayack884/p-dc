type AddressComponent = {
  long_name: string;
  types: string[];
};

const AREA_COMPONENT_TYPES = [
  "administrative_area_level_1",
  "locality",
  "sublocality_level_1",
  "sublocality_level_2",
] as const;

export function formatJapaneseArea(
  components: AddressComponent[]
): string {
  return AREA_COMPONENT_TYPES.map((type) =>
    components.find((component) => component.types.includes(type))?.long_name
  )
    .filter(Boolean)
    .join("");
}

export async function reverseGeocodeArea(
  position: google.maps.LatLngLiteral
): Promise<string> {
  const { Geocoder } = (await google.maps.importLibrary(
    "geocoding"
  )) as google.maps.GeocodingLibrary;
  const response = await new Geocoder().geocode({
    location: position,
    language: "ja",
    region: "JP",
  });
  const area = formatJapaneseArea(
    response.results[0]?.address_components ?? []
  );

  if (!area) {
    throw new Error("現在地の住所を取得できませんでした");
  }
  return area;
}
