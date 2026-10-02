ALTER TABLE rootset_control.tables ADD COLUMN description text NOT NULL DEFAULT '' CHECK(char_length(description)<=4096);
