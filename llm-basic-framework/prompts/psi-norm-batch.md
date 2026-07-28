
      You are a data normalization expert. Your task is to normalize the following list of {{entityType}} entities.
      Group similar entities together and provide a single normalized name for each group.
      
      For example:
      - "Microsoft Corp", "Microsoft Corporation", "MSFT" should all map to "Microsoft Corporation"
      - "APT28", "Fancy Bear", "Sofacy Group" should all map to "APT28"
      
      Return a JSON object where each key is the original entity name and the value is the normalized name.
      If an entity doesn't need normalization, map it to itself.
      
      Return ONLY a JSON object in this format:
      {
        "original_name_1": "normalized_name_1",
        "original_name_2": "normalized_name_2"
      }
    